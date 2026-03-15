import { beforeEach, describe, expect, it, vi } from "vitest";

const resolverMocks = vi.hoisted(() => ({
  resolveGitHubRuns: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  createGitHubBrowserSession: vi.fn(),
}));

const streamMocks = vi.hoisted(() => ({
  emittedLineCount: 0,
  instances: [] as Array<{
    isClosed: boolean;
    stop: () => Promise<void>;
  }>,
}));

vi.mock("../src/platforms/github/github-run-resolver.js", () => ({
  resolveGitHubRuns: resolverMocks.resolveGitHubRuns,
}));
vi.mock("../src/platforms/github/github-auth.js", () => ({
  createGitHubBrowserSession: authMocks.createGitHubBrowserSession,
}));
vi.mock("../src/platforms/github/github-log-stream.js", () => {
  class GitHubJobLogStream {
    public isClosed = false;
    public lastMessageAt = 0;
    public emittedLineCount = streamMocks.emittedLineCount;
    public readonly finished: Promise<void>;
    private readonly resolveFinished: () => void;

    constructor() {
      let resolveFinished!: () => void;
      this.finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      this.resolveFinished = resolveFinished;
      streamMocks.instances.push(this);
    }

    async start(): Promise<void> {}

    async stop(): Promise<void> {
      this.isClosed = true;
      this.resolveFinished();
    }
  }

  return { GitHubJobLogStream };
});

import { watchGitHub } from "../src/platforms/github/github-run-watcher.js";

describe("watchGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamMocks.emittedLineCount = 0;
    streamMocks.instances.length = 0;
    authMocks.createGitHubBrowserSession.mockResolvedValue({
      context: {},
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("backfills archived logs when a completed job never produced live output", async () => {
    const run = buildRun();
    const job = buildJob({ status: "completed", conclusion: "success" });
    const api = {
      getRun: vi.fn().mockResolvedValue({ ...run, status: "completed", conclusion: "success" }),
      listJobs: vi.fn().mockResolvedValue([job]),
      getJobLogs: vi.fn().mockResolvedValue("first line\nsecond line\n"),
    };

    resolverMocks.resolveGitHubRuns.mockResolvedValue({
      api,
      repo: "owner/repo",
      runs: [{ ...run, status: "completed", conclusion: "success" }],
    });

    const output = createCapturedOutput();
    await watchGitHub({}, defaultOptions(), output);

    expect(api.getJobLogs).toHaveBeenCalledWith(job.id);
    expect(output.lines).toContainEqual({
      label: job.name,
      lines: ["first line", "second line"],
    });
  });

  it("does not backfill archived logs after a live stream already emitted lines", async () => {
    streamMocks.emittedLineCount = 1;

    const run = buildRun({ status: "in_progress", conclusion: null });
    const completedRun = buildRun({ status: "completed", conclusion: "success" });
    const inProgressJob = buildJob({ status: "in_progress", conclusion: null });
    const completedJob = buildJob({ status: "completed", conclusion: "success" });
    const api = {
      getRun: vi
        .fn()
        .mockResolvedValueOnce(run)
        .mockResolvedValueOnce(completedRun),
      listJobs: vi
        .fn()
        .mockResolvedValueOnce([inProgressJob])
        .mockResolvedValueOnce([completedJob]),
      getJobLogs: vi.fn().mockResolvedValue("archive"),
    };

    resolverMocks.resolveGitHubRuns.mockResolvedValue({
      api,
      repo: "owner/repo",
      runs: [run],
    });

    const output = createCapturedOutput();
    await watchGitHub({}, defaultOptions(), output);

    expect(authMocks.createGitHubBrowserSession).toHaveBeenCalledTimes(1);
    expect(api.getJobLogs).not.toHaveBeenCalled();
    expect(output.statuses).toContain(`Attached to ${inProgressJob.name}.`);
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

function buildJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 11,
    name: "test-job",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/owner/repo/actions/runs/1/job/11",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function defaultOptions() {
  return {
    storageState: "~/.stare/github/storage-state.json",
    pollIntervalMs: 0,
    loginTimeoutMs: 1,
    attachTimeoutMs: 1,
    idleShutdownMs: 0,
  };
}

function createCapturedOutput() {
  const statuses: string[] = [];
  const errors: string[] = [];
  const lines: Array<{ label: string; lines: readonly string[] }> = [];

  return {
    statuses,
    errors,
    lines,
    status(message: string) {
      statuses.push(message);
    },
    error(message: string) {
      errors.push(message);
    },
    writeLines(label: string, renderedLines: readonly string[]) {
      lines.push({ label, lines: [...renderedLines] });
    },
  };
}
