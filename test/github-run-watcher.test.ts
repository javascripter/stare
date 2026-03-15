import { describe, expect, it } from "vitest";
import {
  shouldBackfillArchivedLogs,
  shouldFailForRunConclusion,
} from "../src/platforms/github/github-run-watcher.js";

describe("shouldFailForRunConclusion", () => {
  it("treats success-like conclusions as zero-exit conclusions", () => {
    expect(shouldFailForRunConclusion("success")).toBe(false);
    expect(shouldFailForRunConclusion("neutral")).toBe(false);
    expect(shouldFailForRunConclusion("skipped")).toBe(false);
  });

  it("treats failure-like conclusions as failures", () => {
    expect(shouldFailForRunConclusion("failure")).toBe(true);
    expect(shouldFailForRunConclusion("cancelled")).toBe(true);
    expect(shouldFailForRunConclusion("timed_out")).toBe(true);
    expect(shouldFailForRunConclusion("action_required")).toBe(true);
    expect(shouldFailForRunConclusion("startup_failure")).toBe(true);
    expect(shouldFailForRunConclusion("stale")).toBe(true);
    expect(shouldFailForRunConclusion(null)).toBe(true);
  });
});

describe("shouldBackfillArchivedLogs", () => {
  it("backs off when no live lines were observed", () => {
    expect(
      shouldBackfillArchivedLogs({
        everAttached: false,
        liveLinesSeen: 0,
      }),
    ).toBe(true);

    expect(
      shouldBackfillArchivedLogs({
        everAttached: true,
        liveLinesSeen: 0,
      }),
    ).toBe(true);
  });

  it("skips archive backfill when live lines were already emitted", () => {
    expect(
      shouldBackfillArchivedLogs({
        everAttached: true,
        liveLinesSeen: 2,
      }),
    ).toBe(false);

    expect(
      shouldBackfillArchivedLogs({
        everAttached: true,
        liveLinesSeen: 0,
        stream: { emittedLineCount: 1 },
      }),
    ).toBe(false);
  });
});
