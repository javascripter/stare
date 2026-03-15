import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({
  inferGitHubRepo: vi.fn(),
  getHeadCommit: vi.fn(),
  getCurrentBranch: vi.fn(),
  resolveCommitish: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  resolveGitHubToken: vi.fn(),
}));

const timerMocks = vi.hoisted(() => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const apiMocks = vi.hoisted(() => ({
  instances: [] as Array<{ repo: string; token?: string }>,
  getRepository: vi.fn(),
  getRun: vi.fn(),
  listRepositoryRuns: vi.fn(),
  listWorkflowRuns: vi.fn(),
  listWorkflows: vi.fn(),
}));

vi.mock("../src/utils/git.js", () => gitMocks);
vi.mock("../src/utils/github-auth.js", () => authMocks);
vi.mock("node:timers/promises", () => ({
  setTimeout: timerMocks.sleep,
}));
vi.mock("../src/platforms/github/github-api.js", () => {
  class GitHubApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly statusText: string,
      readonly path: string,
      readonly body: string,
      readonly repo: string,
      readonly hasToken: boolean,
    ) {
      super(message);
      this.name = "GitHubApiError";
    }
  }

  class GitHubApiClient {
    constructor(repo: string, token?: string) {
      apiMocks.instances.push({ repo, token });
    }

    getRepository(): Promise<unknown> {
      return apiMocks.getRepository();
    }

    getRun(runId: string): Promise<unknown> {
      return apiMocks.getRun(runId);
    }

    listRepositoryRuns(filters: unknown): Promise<unknown> {
      return apiMocks.listRepositoryRuns(filters);
    }

    listWorkflowRuns(workflowId: number, filters: unknown): Promise<unknown> {
      return apiMocks.listWorkflowRuns(workflowId, filters);
    }

    listWorkflows(): Promise<unknown> {
      return apiMocks.listWorkflows();
    }
  }

  return { GitHubApiClient, GitHubApiError };
});

import { resolveGitHubRuns } from "../src/platforms/github/github-run-resolver.js";

describe("resolveGitHubRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.instances.length = 0;
    gitMocks.inferGitHubRepo.mockResolvedValue("owner/repo");
    gitMocks.getCurrentBranch.mockResolvedValue("main");
    gitMocks.getHeadCommit.mockResolvedValue("a".repeat(40));
    gitMocks.resolveCommitish.mockResolvedValue(undefined);
    authMocks.resolveGitHubToken.mockResolvedValue("token");
    apiMocks.getRepository.mockResolvedValue({
      fullName: "owner/repo",
      isPrivate: false,
    });
  });

  it("resolves the latest HEAD run for each workflow in the current repository", async () => {
    apiMocks.listRepositoryRuns.mockResolvedValue([
      buildRun({
        id: 1,
        workflowId: 10,
        runNumber: 1,
        createdAt: "2026-01-01T00:00:00Z",
      }),
      buildRun({
        id: 2,
        workflowId: 10,
        runNumber: 2,
        createdAt: "2026-01-02T00:00:00Z",
      }),
      buildRun({
        id: 3,
        workflowId: 11,
        name: "Lint",
        path: ".github/workflows/lint.yml",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    ]);

    const resolved = await resolveGitHubRuns({}, createOutputSink());

    expect(apiMocks.instances).toEqual([{ repo: "owner/repo", token: "token" }]);
    expect(apiMocks.listRepositoryRuns).toHaveBeenCalledWith({
      branch: "main",
      headSha: "a".repeat(40),
    });
    expect(resolved.repo).toBe("owner/repo");
    expect(resolved.runs.map((run) => run.id)).toEqual([3, 2]);
  });

  it("falls back to head-sha-only workflow discovery after branch-scoped retries", async () => {
    apiMocks.listWorkflows.mockResolvedValue([
      {
        id: 20,
        name: "CI",
        path: ".github/workflows/ci.yml",
        state: "active",
        createdAt: "",
        updatedAt: "",
      },
    ]);
    apiMocks.listWorkflowRuns.mockImplementation(
      async (_workflowId: number, filters: { branch?: string; headSha?: string }) =>
        filters.branch
          ? []
          : [
              buildRun({
                id: 99,
                workflowId: 20,
                createdAt: "2026-01-05T00:00:00Z",
              }),
            ],
    );

    const resolved = await resolveGitHubRuns(
      { workflow: "ci.yml", selector: "a".repeat(40) },
      createOutputSink(),
    );

    expect(apiMocks.listWorkflowRuns).toHaveBeenCalledTimes(7);
    expect(apiMocks.listWorkflowRuns).toHaveBeenLastCalledWith(20, {
      headSha: "a".repeat(40),
    });
    expect(timerMocks.sleep).toHaveBeenCalledTimes(5);
    expect(resolved.runs.map((run) => run.id)).toEqual([99]);
  });

  it("fails early when GitHub authentication could not be resolved", async () => {
    authMocks.resolveGitHubToken.mockRejectedValue(
      new Error("GitHub authentication is required. Run `gh auth login`."),
    );

    await expect(resolveGitHubRuns({}, createOutputSink())).rejects.toThrow(
      "GitHub authentication is required. Run `gh auth login`.",
    );
    expect(apiMocks.instances).toEqual([]);
  });
});

function buildRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    workflowId: 10,
    name: "CI",
    path: ".github/workflows/ci.yml",
    displayTitle: "CI",
    runNumber: 1,
    runAttempt: 1,
    event: "push",
    headSha: "a".repeat(40),
    headBranch: "main",
    htmlUrl: "https://github.com/owner/repo/actions/runs/1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function createOutputSink() {
  return {
    status() {},
    error() {},
    writeLines() {},
  };
}
