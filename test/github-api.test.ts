import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiClient, GitHubApiError } from "../src/platforms/github/github-api.js";

describe("GitHubApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("paginates job listings and maps job fields", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          total_count: 2,
          jobs: [
            {
              id: 101,
              name: "test-1",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/owner/repo/actions/runs/1/job/101",
              started_at: "2026-01-01T00:00:00Z",
              completed_at: "2026-01-01T00:01:00Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total_count: 2,
          jobs: [
            {
              id: 102,
              name: "test-2",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/owner/repo/actions/runs/1/job/102",
            },
          ],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubApiClient("owner/repo", "token");
    await expect(client.listJobs("123")).resolves.toEqual([
      {
        id: 101,
        name: "test-1",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/owner/repo/actions/runs/1/job/101",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
      },
      {
        id: 102,
        name: "test-2",
        status: "in_progress",
        conclusion: null,
        htmlUrl: "https://github.com/owner/repo/actions/runs/1/job/102",
        startedAt: undefined,
        completedAt: undefined,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/actions/runs/123/jobs?per_page=100&page=1",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/owner/repo/actions/runs/123/jobs?per_page=100&page=2",
    );
  });

  it("passes auth headers and query filters when listing repository runs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        total_count: 1,
        workflow_runs: [
          {
            id: 201,
            workflow_id: 10,
            name: "CI",
            path: ".github/workflows/ci.yml",
            display_title: "CI",
            run_number: 5,
            run_attempt: 1,
            event: "push",
            head_sha: "a".repeat(40),
            head_branch: "main",
            html_url: "https://github.com/owner/repo/actions/runs/201",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubApiClient("owner/repo", "secret-token");
    await client.listRepositoryRuns({
      branch: "main",
      headSha: "b".repeat(40),
      event: "push",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.github.com/repos/owner/repo/actions/runs?per_page=100&page=1&branch=main&head_sha=${"b".repeat(40)}&event=push`,
    );

    const headers = fetchMock.mock.calls[0][1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("Authorization")).toBe("Bearer secret-token");
    expect((headers as Headers).get("User-Agent")).toBe("stare-cli");
  });

  it("raises a helpful GitHubApiError for 404 responses without a token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      errorResponse(404, "Not Found", "missing"),
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubApiClient("owner/repo");

    await expect(client.getRun("999")).rejects.toBeInstanceOf(GitHubApiError);
    await expect(client.getRun("999")).rejects.toMatchObject({
      status: 404,
      repo: "owner/repo",
      hasToken: false,
    });
    await expect(client.getRun("999")).rejects.toThrow("GitHub returned 404 without a GitHub API token");
  });

  it("raises a helpful GitHubApiError for invalid tokens", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      errorResponse(401, "Unauthorized", "Bad credentials"),
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubApiClient("owner/repo", "bad-token");

    await expect(client.getRun("999")).rejects.toBeInstanceOf(GitHubApiError);
    await expect(client.getRun("999")).rejects.toMatchObject({
      status: 401,
      repo: "owner/repo",
      hasToken: true,
    });
    await expect(client.getRun("999")).rejects.toThrow("GitHub rejected the API token");
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

function errorResponse(status: number, statusText: string, body: string): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => body,
  } as Response;
}
