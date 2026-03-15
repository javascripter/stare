import { describe, expect, it } from "vitest";
import {
  groupRunsByWorkflow,
  matchWorkflows,
  parseGitHubActionsUrl,
} from "../src/platforms/github/github-run-resolver.js";

describe("parseGitHubActionsUrl", () => {
  it("parses run URLs", () => {
    expect(
      parseGitHubActionsUrl("https://github.com/owner/repo/actions/runs/123456789"),
    ).toEqual({
      repo: "owner/repo",
      runId: "123456789",
    });
  });

  it("parses job URLs", () => {
    expect(
      parseGitHubActionsUrl("https://github.com/owner/repo/actions/runs/123456789/job/987654321"),
    ).toEqual({
      repo: "owner/repo",
      runId: "123456789",
    });
  });

  it("returns undefined for non-actions URLs", () => {
    expect(parseGitHubActionsUrl("https://github.com/owner/repo/pull/1")).toBeUndefined();
  });
});

describe("matchWorkflows", () => {
  const workflows = [
    {
      id: 1,
      name: "Test",
      path: ".github/workflows/test.yml",
      state: "active",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: 2,
      name: "Debug Stream",
      path: ".github/workflows/debug.yml",
      state: "active",
      createdAt: "",
      updatedAt: "",
    },
  ];

  it("matches by exact path", () => {
    expect(matchWorkflows(workflows, ".github/workflows/test.yml")).toEqual([workflows[0]]);
  });

  it("matches by basename", () => {
    expect(matchWorkflows(workflows, "debug.yml")).toEqual([workflows[1]]);
  });

  it("matches by display name", () => {
    expect(matchWorkflows(workflows, "Test")).toEqual([workflows[0]]);
  });
});

describe("groupRunsByWorkflow", () => {
  it("keeps the latest run per workflow", () => {
    const grouped = groupRunsByWorkflow([
      {
        id: 1,
        workflowId: 10,
        name: "Test",
        path: ".github/workflows/test.yml",
        displayTitle: "Test",
        runNumber: 1,
        runAttempt: 1,
        event: "push",
        headSha: "a".repeat(40),
        headBranch: "main",
        htmlUrl: "",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 2,
        workflowId: 10,
        name: "Test",
        path: ".github/workflows/test.yml",
        displayTitle: "Test",
        runNumber: 2,
        runAttempt: 1,
        event: "push",
        headSha: "b".repeat(40),
        headBranch: "main",
        htmlUrl: "",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 3,
        workflowId: 11,
        name: "Debug",
        path: ".github/workflows/debug.yml",
        displayTitle: "Debug",
        runNumber: 1,
        runAttempt: 1,
        event: "push",
        headSha: "c".repeat(40),
        headBranch: "main",
        htmlUrl: "",
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.find((entry) => entry.workflowId === 10)?.latestRun.id).toBe(2);
    expect(grouped.find((entry) => entry.workflowId === 11)?.latestRun.id).toBe(3);
  });
});
