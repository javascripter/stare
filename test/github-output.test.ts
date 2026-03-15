import { createColors } from "picocolors";
import { describe, expect, it } from "vitest";
import { GitHubFormattedOutput } from "../src/platforms/github/github-output.js";

const colors = createColors(true);

describe("GitHubFormattedOutput", () => {
  it("removes runner timestamps, preserves ANSI payloads, and colors group and command lines", () => {
    const written: Array<{ label: string; lines: readonly string[] }> = [];
    const output = new GitHubFormattedOutput({
      status() {},
      error() {},
      writeLines(label: string, lines: readonly string[]) {
        written.push({ label, lines });
      },
    }, {
      group(text: string) {
        return colors.bold(text);
      },
      command(text: string) {
        return colors.cyan(text);
      },
      warning(text: string) {
        return colors.yellow(text);
      },
      error(text: string) {
        return colors.red(text);
      },
      notice(text: string) {
        return colors.blue(text);
      },
    });

    output.writeLines("test", [
      "2026-03-15T19:58:42.4130318Z ##[group]Run actions/checkout@v5",
      "2026-03-15T19:58:43.5638799Z [command]/usr/bin/git version",
      "2026-03-15T19:58:43.5686423Z \u001b[36;1mgit version 2.53.0\u001b[0m",
      "2026-03-15T19:58:43.5711886Z ##[endgroup]",
    ]);

    expect(written).toEqual([
      {
        label: "test",
        lines: [
          colors.bold("Run actions/checkout@v5"),
          `  ${colors.cyan("$ /usr/bin/git version")}`,
          "  \u001b[36;1mgit version 2.53.0\u001b[0m",
        ],
      },
    ]);
  });

  it("renders annotations with semantic colors", () => {
    const written: Array<{ label: string; lines: readonly string[] }> = [];
    const output = new GitHubFormattedOutput({
      status() {},
      error() {},
      writeLines(label: string, lines: readonly string[]) {
        written.push({ label, lines });
      },
    }, {
      group(text: string) {
        return colors.bold(text);
      },
      command(text: string) {
        return colors.cyan(text);
      },
      warning(text: string) {
        return colors.yellow(text);
      },
      error(text: string) {
        return colors.red(text);
      },
      notice(text: string) {
        return colors.blue(text);
      },
    });

    output.writeLines("test", [
      "2026-03-15T19:58:42.4130318Z ##[warning]This is a warning",
      "2026-03-15T19:58:42.4130318Z ##[error]This is an error",
      "2026-03-15T19:58:42.4130318Z ##[notice]This is a notice",
    ]);

    expect(written).toEqual([
      {
        label: "test",
        lines: [
          colors.yellow("warning: This is a warning"),
          colors.red("error: This is an error"),
          colors.blue("notice: This is a notice"),
        ],
      },
    ]);
  });
});
