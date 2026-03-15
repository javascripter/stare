export interface GitHubRun {
  id: number;
  workflowId: number;
  name: string;
  path: string;
  displayTitle: string;
  runNumber: number;
  runAttempt: number;
  event: string;
  headSha: string;
  headBranch: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  conclusion: string | null;
}

export interface GitHubJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  startedAt?: string;
  completedAt?: string;
}

export interface GitHubRepository {
  fullName: string;
  isPrivate: boolean;
}

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
    readonly body: string,
    readonly repo: string,
    readonly hasToken: boolean,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface GitHubRunResponse {
  id: number;
  workflow_id: number;
  name: string;
  path: string;
  display_title: string;
  run_number: number;
  run_attempt: number;
  event: string;
  head_sha: string;
  head_branch: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  status: string;
  conclusion: string | null;
}

interface GitHubJobsResponse {
  total_count: number;
  jobs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    started_at?: string;
    completed_at?: string;
  }>;
}

interface GitHubRepositoryResponse {
  full_name: string;
  private: boolean;
}

interface GitHubRunsResponse {
  total_count: number;
  workflow_runs: GitHubRunResponse[];
}

interface GitHubWorkflowsResponse {
  total_count: number;
  workflows: Array<{
    id: number;
    name: string;
    path: string;
    state: string;
    created_at: string;
    updated_at: string;
  }>;
}

interface ListRunOptions {
  branch?: string;
  headSha?: string;
  event?: string;
}

interface GitHubPaginatedResult<T> {
  totalCount: number;
  items: T[];
}

export class GitHubApiClient {
  constructor(
    private readonly repo: string,
    private readonly token?: string,
  ) {}

  async getRun(runId: string): Promise<GitHubRun> {
    const response = await this.request<GitHubRunResponse>(
      `/repos/${this.repo}/actions/runs/${runId}`,
    );

    return mapRun(response);
  }

  async getRepository(): Promise<GitHubRepository> {
    const response = await this.request<GitHubRepositoryResponse>(`/repos/${this.repo}`);
    return {
      fullName: response.full_name,
      isPrivate: response.private,
    };
  }

  async listJobs(runId: string): Promise<GitHubJob[]> {
    return this.paginate((page) =>
      this.request<GitHubJobsResponse>(
        `/repos/${this.repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      ).then((response) => ({
        totalCount: response.total_count,
        items: response.jobs.map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          htmlUrl: job.html_url,
          startedAt: job.started_at,
          completedAt: job.completed_at,
        })),
      })),
    );
  }

  async listRepositoryRuns(options: ListRunOptions = {}): Promise<GitHubRun[]> {
    return this.listRuns(`/repos/${this.repo}/actions/runs`, options);
  }

  async listWorkflowRuns(workflowId: number, options: ListRunOptions = {}): Promise<GitHubRun[]> {
    return this.listRuns(`/repos/${this.repo}/actions/workflows/${workflowId}/runs`, options);
  }

  async listWorkflows(): Promise<GitHubWorkflow[]> {
    return this.paginate((page) =>
      this.request<GitHubWorkflowsResponse>(
        `/repos/${this.repo}/actions/workflows?per_page=100&page=${page}`,
      ).then((response) => ({
        totalCount: response.total_count,
        items: response.workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          path: workflow.path,
          state: workflow.state,
          createdAt: workflow.created_at,
          updatedAt: workflow.updated_at,
        })),
      })),
    );
  }

  async getJobLogs(jobId: number): Promise<string> {
    const response = await fetch(
      `https://api.github.com/repos/${this.repo}/actions/jobs/${jobId}/logs`,
      {
        headers: this.createHeaders(),
        redirect: "follow",
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw this.toApiError(
        response.status,
        response.statusText,
        `/repos/${this.repo}/actions/jobs/${jobId}/logs`,
        body,
      );
    }

    return response.text();
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: this.createHeaders(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw this.toApiError(response.status, response.statusText, path, body);
    }

    return (await response.json()) as T;
  }

  private async listRuns(basePath: string, options: ListRunOptions): Promise<GitHubRun[]> {
    return this.paginate((page) =>
      this.request<GitHubRunsResponse>(`${basePath}?${buildRunQuery(page, options)}`).then(
        (response) => ({
          totalCount: response.total_count,
          items: response.workflow_runs.map(mapRun),
        }),
      ),
    );
  }

  private createHeaders(): Headers {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "User-Agent": "stare-cli",
      "X-GitHub-Api-Version": "2022-11-28",
    });

    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    return headers;
  }

  private async paginate<T>(
    requestPage: (page: number) => Promise<GitHubPaginatedResult<T>>,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    let totalCount = Number.POSITIVE_INFINITY;

    while (items.length < totalCount) {
      const response = await requestPage(page);
      totalCount = response.totalCount;
      items.push(...response.items);

      if (response.items.length === 0) {
        break;
      }

      page += 1;
    }

    return items;
  }

  private toApiError(
    status: number,
    statusText: string,
    path: string,
    body: string,
  ): GitHubApiError {
    const normalizedBody = body.trim().toLowerCase();

    if (status === 404 && !this.token) {
      return new GitHubApiError(
        "GitHub returned 404 without a GitHub API token. For private repositories and private Actions runs, GitHub often hides unauthenticated access behind 404. Provide --token, set GITHUB_TOKEN, or run `gh auth login` so `gh auth token` succeeds.",
        status,
        statusText,
        path,
        body,
        this.repo,
        false,
      );
    }

    if (status === 401) {
      return new GitHubApiError(
        `GitHub rejected the API token for ${this.repo} while requesting ${path} (${status} ${statusText}). Verify --token or GITHUB_TOKEN, or refresh the GitHub CLI login if you rely on \`gh auth token\`.`,
        status,
        statusText,
        path,
        body,
        this.repo,
        Boolean(this.token),
      );
    }

    if (status === 403) {
      const message = normalizedBody.includes("rate limit")
        ? `GitHub API rate limiting blocked ${path} in ${this.repo}. Wait for the rate limit to reset, or retry with a token that has a higher limit.`
        : `GitHub denied access to ${path} in ${this.repo} (${status} ${statusText}). The token may be missing repository or Actions permissions for this resource.`;

      return new GitHubApiError(
        message,
        status,
        statusText,
        path,
        body,
        this.repo,
        Boolean(this.token),
      );
    }

    if (status === 404) {
      return new GitHubApiError(
        `GitHub returned 404 for ${path} in ${this.repo}. The repository, run, or job may not exist there, or the token may not be allowed to view this private resource.`,
        status,
        statusText,
        path,
        body,
        this.repo,
        Boolean(this.token),
      );
    }

    const detail = body ? ` ${body}` : "";
    return new GitHubApiError(
      `GitHub API request failed (${status} ${statusText}) for ${path}.${detail}`,
      status,
      statusText,
      path,
      body,
      this.repo,
      Boolean(this.token),
    );
  }
}

function mapRun(response: GitHubRunResponse): GitHubRun {
  return {
    id: response.id,
    workflowId: response.workflow_id,
    name: response.name,
    path: response.path,
    displayTitle: response.display_title,
    runNumber: response.run_number,
    runAttempt: response.run_attempt,
    event: response.event,
    headSha: response.head_sha,
    headBranch: response.head_branch,
    htmlUrl: response.html_url,
    createdAt: response.created_at,
    updatedAt: response.updated_at,
    status: response.status,
    conclusion: response.conclusion,
  };
}

function buildRunQuery(page: number, options: ListRunOptions): string {
  const query = new URLSearchParams({
    per_page: "100",
    page: String(page),
  });

  if (options.branch) {
    query.set("branch", options.branch);
  }

  if (options.headSha) {
    query.set("head_sha", options.headSha);
  }

  if (options.event) {
    query.set("event", options.event);
  }

  return query.toString();
}
