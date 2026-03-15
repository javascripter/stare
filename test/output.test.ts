import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalOutput } from "../src/core/output.js";

describe("TerminalOutput", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes each physical line of multiline output", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    const output = new TerminalOutput();
    output.writeLines("Android", ['first line\nsecond line', "third line"]);

    expect(writes.map((line) => stripVTControlCharacters(line))).toEqual([
      "[Android] first line\n",
      "[Android] second line\n",
      "[Android] third line\n",
    ]);
  });
});
