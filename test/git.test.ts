import { describe, expect, it } from "vitest";
import { parseGitHubRepo } from "../src/utils/git.js";

describe("parseGitHubRepo", () => {
  it("parses ssh remotes", () => {
    expect(parseGitHubRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  it("parses https remotes", () => {
    expect(parseGitHubRepo("https://github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("parses ssh URLs", () => {
    expect(parseGitHubRepo("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("rejects non-github remotes", () => {
    expect(parseGitHubRepo("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });
});
