import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AlreadyReportedError } from "../src/core/error.js";
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
    expect(output.statuses).toContain("Summary: 1 build");
    expect(output.statuses).toContain("  ✓ Android Finished");
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

  it("watches multiple explicit builds and labels same-platform output separately", async () => {
    const secondBuildId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const firstLog = logUrl(BUILD_ID, "queue.txt", "first");
    const secondLog = logUrl(secondBuildId, "queue.txt", "second");
    const getBuild = vi.fn<(buildId: string) => Promise<EasBuild>>().mockImplementation(async (buildId) => {
      if (buildId === BUILD_ID) {
        return build({
          id: BUILD_ID,
          status: "FINISHED",
          logFiles: [firstLog],
          artifacts: {
            applicationArchiveUrl: APPLICATION_ARCHIVE_URL,
          },
        });
      }

      if (buildId === secondBuildId) {
        return build({
          id: secondBuildId,
          status: "FINISHED",
          logFiles: [secondLog],
          artifacts: {
            applicationArchiveUrl: "https://downloads.example.test/app-release-2.apk",
          },
        });
      }

      throw new Error(`Unexpected build: ${buildId}`);
    });
    const getLogFile = vi.fn<(url: string) => Promise<string>>().mockImplementation(async (url) => {
      if (url === firstLog) {
        return [
          entry({ phase: "QUEUE", marker: "START_PHASE" }),
          entry({ phase: "QUEUE", msg: "First build" }),
          entry({ phase: "QUEUE", marker: "END_PHASE" }),
        ].join("\n");
      }

      if (url === secondLog) {
        return [
          entry({ phase: "QUEUE", marker: "START_PHASE" }),
          entry({ phase: "QUEUE", msg: "Second build" }),
          entry({ phase: "QUEUE", marker: "END_PHASE" }),
        ].join("\n");
      }

      throw new Error(`Unexpected log URL: ${url}`);
    });

    const output = createCapturedOutput();

    await watchEasBuild(
      [BUILD_ID, secondBuildId],
      {
        pollIntervalMs: 0,
      },
      output,
      { getBuild, getLogFile },
    );

    expect(output.lines).toEqual(
      expect.arrayContaining([
        {
          label: "Android 11111111",
          lines: ["Waiting to start", "  First build"],
        },
        {
          label: "Android 66666666",
          lines: ["Waiting to start", "  Second build"],
        },
      ]),
    );
    expect(output.statuses).toContain("Summary: 2 builds");
    expect(output.statuses).toContain("  ✓ Android 11111111 Finished");
    expect(output.statuses).toContain("  ✓ Android 66666666 Finished");
  });

  it("prints the summary before failing and marks build failures as already reported", async () => {
    const failedLog = logUrl(BUILD_ID, "run-gradlew.txt", "failed");
    const getBuild = vi
      .fn<(buildId: string) => Promise<EasBuild>>()
      .mockResolvedValue(
        build({
          id: BUILD_ID,
          status: "ERRORED",
          logFiles: [failedLog],
          error: {
            message: "Build failed remotely.",
          },
        }),
      );
    const getLogFile = vi.fn<(url: string) => Promise<string>>().mockResolvedValue(
      [
        entry({ phase: "FAIL_BUILD", marker: "START_PHASE" }),
        entry({ phase: "FAIL_BUILD", msg: "Build failed remotely." }),
      ].join("\n"),
    );

    const output = createCapturedOutput();

    await expect(
      watchEasBuild(
        BUILD_URL,
        {
          pollIntervalMs: 0,
        },
        output,
        { getBuild, getLogFile },
      ),
    ).rejects.toBeInstanceOf(AlreadyReportedError);

    expect(output.statuses).toContain("Summary: 1 build");
    expect(output.statuses).toContain("  ✗ Android Errored");
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
