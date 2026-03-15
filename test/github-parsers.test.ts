import { describe, expect, it } from "vitest";
import {
  hasActionsResultsSubscription,
  parseActionsResultsLines,
  parseGitHubBackscrollLines,
} from "../src/platforms/github/github-parsers.js";

describe("github live log parsers", () => {
  it("extracts lines from a GitHub backscroll response", () => {
    const payload = JSON.stringify({
      lines: [
        { id: "1", line: "tick=01" },
        { id: "2", line: "tick=02" },
      ],
    });

    expect(parseGitHubBackscrollLines(payload)).toEqual([
      { id: "1", line: "tick=01" },
      { id: "2", line: "tick=02" },
    ]);
  });

  it("detects actions_results subscriptions from the shared worker payload", () => {
    expect(
      hasActionsResultsSubscription({
        subscribe: [{ name: "actions_results:abc" }, { name: "check_runs:123" }],
      }),
    ).toBe(true);
    expect(
      hasActionsResultsSubscription({
        subscribe: [{ name: "check_runs:123" }],
      }),
    ).toBe(false);
  });

  it("extracts lines from shared worker live messages", () => {
    expect(
      parseActionsResultsLines({
        channel: "actions_results:abc",
        data: {
          data: {
            lines: [
              { lineID: "l1", line: "tick=02" },
              { lineID: "l2", line: "tick=03" },
            ],
          },
        },
      }),
    ).toEqual([
      { id: "l1", line: "tick=02" },
      { id: "l2", line: "tick=03" },
    ]);
  });
});
