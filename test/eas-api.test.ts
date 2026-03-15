import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExpoApiClient,
  resolveExpoApiHeaders,
} from "../src/platforms/eas/eas-api.js";
import * as pathUtils from "../src/utils/path.js";

const BUILD_ID = "11111111-2222-4333-8444-555555555555";
const APP_SLUG = "example-app";
const OWNER_NAME = "example-owner";

describe("Expo API auth and client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the Expo CLI session file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "stare-expo-auth-"));
    const statePath = join(tempDir, ".expo", "state.json");
    mkdirSync(join(tempDir, ".expo"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ auth: { sessionSecret: "session-secret" } }));

    try {
      vi.spyOn(pathUtils, "expandHomeDirectory").mockReturnValue(statePath);

      const headers = await resolveExpoApiHeaders();
      expect(headers.get("expo-session")).toBe("session-secret");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("explains how to restore Expo authentication when the session file is missing", async () => {
    vi.spyOn(pathUtils, "expandHomeDirectory").mockReturnValue("/missing/.expo/state.json");

    await expect(resolveExpoApiHeaders()).rejects.toThrow(
      "stare reads Expo login state from the EAS CLI session file. Install EAS CLI if needed, run `eas login`, then retry.",
    );
  });

  it("requests builds from the Expo GraphQL API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          builds: {
            byId: {
              id: BUILD_ID,
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
              updatedAt: "2026-03-15T21:44:12.850Z",
              completedAt: null,
            },
          },
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new ExpoApiClient(
      new Headers({
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      }),
    );

    await expect(client.getBuild(BUILD_ID)).resolves.toMatchObject({
      id: BUILD_ID,
      status: "IN_PROGRESS",
      platform: "ANDROID",
      project: {
        slug: APP_SLUG,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.expo.dev/graphql");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0][1]?.headers).toBeInstanceOf(Headers);
    expect((fetchMock.mock.calls[0][1]?.headers as Headers).get("authorization")).toBe(
      "Bearer secret-token",
    );
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}
