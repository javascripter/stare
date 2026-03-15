import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { EasBuild } from "../src/platforms/eas/eas-api.js";
import {
  getLogFileKey,
  parseEasLogEntries,
  watchEasBuild,
} from "../src/platforms/eas/eas-build-watcher.js";

const BUILD_ID = "11111111-2222-4333-8444-555555555555";
const APP_SLUG = "example-app";
const OWNER_NAME = "example-owner";
const BUILD_URL = `https://expo.dev/accounts/${OWNER_NAME}/projects/${APP_SLUG}/builds/${BUILD_ID}`;
const APPLICATION_ARCHIVE_URL = "https://downloads.example.test/app-release.apk";

describe("watchEasBuild", () => {
  it("streams log growth across rotating signed URLs and does a final terminal refresh", async () => {
    const queueA = logUrl(BUILD_ID, "queue.txt", "a");
    const queueB = logUrl(BUILD_ID, "queue.txt", "b");
    const queueC = logUrl(BUILD_ID, "queue.txt", "c");
    const queueD = logUrl(BUILD_ID, "queue.txt", "d");
    const gradleA = logUrl(BUILD_ID, "run-gradlew.txt", "a");
    const gradleB = logUrl(BUILD_ID, "run-gradlew.txt", "b");
    const gradleC = logUrl(BUILD_ID, "run-gradlew.txt", "c");
    const gradleD = logUrl(BUILD_ID, "run-gradlew.txt", "d");
    const finalC = logUrl(BUILD_ID, "post-build.txt", "c");
    const finalD = logUrl(BUILD_ID, "post-build.txt", "d");

    const getBuild = vi
      .fn<() => Promise<EasBuild>>()
      .mockResolvedValueOnce(
        build({
          id: BUILD_ID,
          status: "IN_PROGRESS",
          logFiles: [queueA, gradleA],
          updatedAt: "2026-03-15T21:44:12.850Z",
        }),
      )
      .mockResolvedValueOnce(
        build({
          id: BUILD_ID,
          status: "IN_PROGRESS",
          logFiles: [queueB, gradleB],
          updatedAt: "2026-03-15T21:44:30.000Z",
        }),
      )
      .mockResolvedValueOnce(
        build({
          id: BUILD_ID,
          status: "FINISHED",
          logFiles: [queueC, gradleC, finalC],
          updatedAt: "2026-03-15T21:50:00.000Z",
          artifacts: {
            applicationArchiveUrl: APPLICATION_ARCHIVE_URL,
          },
        }),
      )
      .mockResolvedValueOnce(
        build({
          id: BUILD_ID,
          status: "FINISHED",
          logFiles: [queueD, gradleD, finalD],
          updatedAt: "2026-03-15T21:50:05.000Z",
          artifacts: {
            applicationArchiveUrl: APPLICATION_ARCHIVE_URL,
          },
        }),
      );

    const getLogFile = vi
      .fn<(url: string) => Promise<string>>()
      .mockImplementation(async (url) => {
        switch (url) {
          case queueA:
          case queueB:
          case queueC:
          case queueD:
            return [
              entry({ phase: "QUEUE", marker: "START_PHASE" }),
              entry({ phase: "QUEUE", msg: "Waiting to start" }),
              entry({ phase: "QUEUE", marker: "END_PHASE" }),
            ].join("\n");
          case gradleA:
            return [
              entry({ phase: "RUN_GRADLEW", marker: "START_PHASE" }),
              entry({ phase: "RUN_GRADLEW", msg: "Running prebuild" }),
            ].join("\n");
          case gradleB:
          case gradleC:
            return [
              entry({ phase: "RUN_GRADLEW", marker: "START_PHASE" }),
              entry({ phase: "RUN_GRADLEW", msg: "Running prebuild" }),
              entry({ phase: "RUN_GRADLEW", msg: "Running gradle" }),
            ].join("\n");
          case gradleD:
            return [
              entry({ phase: "RUN_GRADLEW", marker: "START_PHASE" }),
              entry({ phase: "RUN_GRADLEW", msg: "Running prebuild" }),
              entry({ phase: "RUN_GRADLEW", msg: "Running gradle" }),
              entry({ phase: "RUN_GRADLEW", msg: "Packaging build" }),
              entry({ phase: "RUN_GRADLEW", marker: "END_PHASE" }),
            ].join("\n");
          case finalC:
            return [
              entry({ phase: "POST_BUILD", marker: "START_PHASE" }),
              entry({ phase: "POST_BUILD", msg: "Uploading artifact" }),
            ].join("\n");
          case finalD:
            return [
              entry({ phase: "POST_BUILD", marker: "START_PHASE" }),
              entry({ phase: "POST_BUILD", msg: "Uploading artifact" }),
              entry({ phase: "POST_BUILD", msg: "Build ready" }),
              entry({ phase: "POST_BUILD", marker: "END_PHASE" }),
            ].join("\n");
          default:
            throw new Error(`Unexpected log URL: ${url}`);
        }
      });

    const output = createCapturedOutput();

    await watchEasBuild(
      BUILD_URL,
      {
        pollIntervalMs: 0,
      },
      output,
      { getBuild, getLogFile },
    );

    expect(getBuild).toHaveBeenCalledTimes(4);
    expect(output.lines).toEqual([
      {
        label: "Android",
        lines: ["Waiting to start", "  Waiting to start"],
      },
      {
        label: "Android",
        lines: ["Run gradlew", "  Running prebuild"],
      },
      {
        label: "Android",
        lines: ["  Running gradle"],
      },
      {
        label: "Android",
        lines: ["Post Build", "  Uploading artifact"],
      },
      {
        label: "Android",
        lines: ["Run gradlew", "  Packaging build"],
      },
      {
        label: "Android",
        lines: ["Post Build", "  Build ready"],
      },
    ]);
    expect(output.statuses).toContain(`Logs: ${BUILD_URL}`);
    expect(output.statuses).toContain("Build Finished.");
    expect(output.statuses).toContain(`Application archive: ${APPLICATION_ARCHIVE_URL}`);
  });

  it("parses raw lines and strips signatures from log file keys", () => {
    expect(
      parseEasLogEntries(
        [
          entry({ phase: "RUN_GRADLEW", msg: "Running gradle" }),
          "not-json",
        ].join("\n"),
      ),
    ).toEqual([
      { phase: "RUN_GRADLEW", msg: "Running gradle" },
      { msg: "not-json" },
    ]);

    expect(
      getLogFileKey(
        "https://logs.example.test/production/build-id/run-gradlew.txt?X-Goog-Signature=abc",
      ),
    ).toBe("/production/build-id/run-gradlew.txt");
  });
});

function build(overrides: Partial<EasBuild>): EasBuild {
  return {
    id: "build-id",
    status: "IN_PROGRESS",
    platform: "ANDROID",
    error: null,
    artifacts: null,
    logFiles: [],
    project: {
      id: "project-id",
      name: APP_SLUG,
      slug: APP_SLUG,
      ownerAccount: {
        id: "owner-id",
        name: OWNER_NAME,
      },
    },
    channel: "preview",
    distribution: "INTERNAL",
    buildProfile: "preview",
    createdAt: "2026-03-15T21:43:11.893Z",
    updatedAt: "2026-03-15T21:43:11.893Z",
    completedAt: null,
    ...overrides,
  };
}

function logUrl(buildId: string, fileName: string, signature: string): string {
  return `https://logs.example.test/production/${buildId}/${fileName}?X-Goog-Signature=${signature}`;
}

function entry(payload: Record<string, string>): string {
  return JSON.stringify(payload);
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
      lines.push({
        label: stripVTControlCharacters(label),
        lines: renderedLines.map((line) => stripVTControlCharacters(line)),
      });
    },
  };
}
