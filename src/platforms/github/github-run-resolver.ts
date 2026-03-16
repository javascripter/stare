import { createInterface } from "node:readline/promises";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OutputSink } from "../../core/output.js";
import {
  getCurrentBranch,
  getHeadCommit,
  inferGitHubRepo,
  resolveCommitish,
} from "../../utils/git.js";
import { resolveGitHubToken } from "../../utils/github-auth.js";
import {
  GitHubApiClient,
  GitHubApiError,
  type GitHubRun,
  type GitHubWorkflow,
} from "./github-api.js";

export interface GitHubResolvedRuns {
  api: GitHubApiClient;
  repo: string;
  runs: GitHubRun[];
}

export interface GitHubResolveOptions {
  selector?: string;
  repo?: string;
  runId?: string[];
  token?: string;
  workflow?: string;
}

interface GitContext {
  repo?: string;
  headSha?: string;
  branch?: string;
}

interface ParsedActionsUrl {
  repo: string;
  runId: string;
}

interface CandidateWorkflow {
  workflowId: number;
  name: string;
  path: string;
  latestRun: GitHubRun;
}

const RUN_DISCOVERY_RETRY_ATTEMPTS = 6;
const RUN_DISCOVERY_RETRY_DELAY_MS = 1_000;

export async function resolveGitHubRuns(
  options: GitHubResolveOptions,
  output: OutputSink,
  cwd: string = process.cwd(),
): Promise<GitHubResolvedRuns> {
  const parsedUrl = parseGitHubActionsUrl(options.selector);
  const selectorRunId =
    parsedUrl?.runId ?? (options.selector && /^\d+$/u.test(options.selector) ? options.selector : undefined);
  const explicitRunIds = options.runId ?? [];

  if (explicitRunIds.length > 0 && options.selector) {
    throw new Error(
      "Received both a positional selector and --run-id. Provide only one run selector.",
    );
  }
  if ((selectorRunId || explicitRunIds.length > 0) && options.workflow) {
    throw new Error(
      "Received both a run selector and --workflow. Use the run selector by itself, or remove it and select the workflow explicitly.",
    );
  }

  const gitContext = await readGitContext(cwd);
  const repo = resolveRepo(options.repo, parsedUrl?.repo, gitContext.repo);
  if (!repo) {
    throw new Error(
      "Could not determine a GitHub repository. Run this inside a GitHub repo or pass --repo owner/repo.",
    );
  }

  const token = options.token ?? (await resolveGitHubToken(cwd));
  const api = new GitHubApiClient(repo, token);
  await api.getRepository();

  const selectedRunIds = explicitRunIds.length > 0
    ? explicitRunIds
    : selectorRunId
      ? [selectorRunId]
      : [];

  if (selectedRunIds.length > 0) {
    return {
      api,
      repo,
      runs: await Promise.all(
        selectedRunIds.map((runId) => getRunWithFriendlyErrors(api, runId, repo)),
      ),
    };
  }

  const commitSelector = options.selector;
  const sameRepoAsCwd = gitContext.repo !== undefined && gitContext.repo === repo;
  const implicitBranch = sameRepoAsCwd ? gitContext.branch : undefined;

  let headSha: string | undefined;
  if (commitSelector) {
    headSha = await resolveCommitSelector(commitSelector, cwd, sameRepoAsCwd);
  } else if (options.workflow) {
    headSha = undefined;
  } else {
    if (!sameRepoAsCwd) {
      throw new Error(
        "stare gh without arguments needs the current GitHub repository and branch. Run this inside the target repo, or pass a run ID, commit SHA, GitHub Actions URL, --workflow, or --run-id.",
      );
    }

    if (gitContext.headSha) {
      headSha = gitContext.headSha;
    } else {
      throw new Error(
        "stare gh without arguments needs the current HEAD commit. Check out the target commit or branch, or pass a run ID, commit SHA, GitHub Actions URL, --workflow, or --run-id.",
      );
    }
  }

  if (options.workflow) {
    const workflow = await selectWorkflow(api, options.workflow, output);
    const runs = await listRunsWithRetry(api, workflow.id, {
      branch: implicitBranch,
      headSha,
    });

    if (runs.length === 0) {
      throw new Error(buildNoRunsMessage(repo, headSha, implicitBranch, workflow));
    }

    return { api, repo, runs: [pickLatestRun(runs)] };
  }

  const runs = await listRepositoryRunsWithRetry(api, {
    branch: implicitBranch,
    headSha,
  });

  if (runs.length === 0) {
    throw new Error(buildNoRunsMessage(repo, headSha, implicitBranch));
  }

  const groupedWorkflows = groupRunsByWorkflow(runs);
  return {
    api,
    repo,
    runs: groupedWorkflows.map((workflow) => workflow.latestRun),
  };
}

export function parseGitHubActionsUrl(selector?: string): ParsedActionsUrl | undefined {
  if (!selector) {
    return undefined;
  }

  try {
    const url = new URL(selector);
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/\d+)?\/?$/u);
    if (!match) {
      return undefined;
    }

    return {
      repo: match[1],
      runId: match[2],
    };
  } catch {
    return undefined;
  }
}

export function matchWorkflows(
  workflows: readonly GitHubWorkflow[],
  workflowSelector: string,
): GitHubWorkflow[] {
  const normalized = workflowSelector.trim().toLowerCase();
  const exactPathMatches = workflows.filter((workflow) => workflow.path === workflowSelector);
  if (exactPathMatches.length > 0) {
    return exactPathMatches;
  }

  const exactBaseNameMatches = workflows.filter(
    (workflow) => basename(workflow.path) === workflowSelector,
  );
  if (exactBaseNameMatches.length > 0) {
    return exactBaseNameMatches;
  }

  const exactNameMatches = workflows.filter((workflow) => workflow.name === workflowSelector);
  if (exactNameMatches.length > 0) {
    return exactNameMatches;
  }

  const normalizedMatches = workflows.filter((workflow) => {
    return (
      workflow.name.toLowerCase() === normalized ||
      workflow.path.toLowerCase() === normalized ||
      basename(workflow.path).toLowerCase() === normalized
    );
  });

  return normalizedMatches;
}

export function groupRunsByWorkflow(runs: readonly GitHubRun[]): CandidateWorkflow[] {
  const byWorkflow = new Map<number, CandidateWorkflow>();

  for (const run of sortRuns(runs)) {
    const existing = byWorkflow.get(run.workflowId);
    if (existing) {
      continue;
    }

    byWorkflow.set(run.workflowId, {
      workflowId: run.workflowId,
      name: run.name,
      path: run.path,
      latestRun: run,
    });
  }

  return [...byWorkflow.values()];
}

async function selectWorkflow(
  api: GitHubApiClient,
  workflowSelector: string,
  output: OutputSink,
): Promise<GitHubWorkflow> {
  const workflows = await api.listWorkflows();
  const matches = matchWorkflows(workflows, workflowSelector);

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0) {
    throw new Error(buildWorkflowNotFoundMessage(workflowSelector, workflows));
  }

  if (!isInteractive()) {
    throw new Error(buildWorkflowAmbiguityMessage(workflowSelector, matches));
  }

  const choice = await promptChoice(
    `Multiple workflows matched "${workflowSelector}". Select one to stare at:`,
    matches.map((workflow) => ({
      label: `${workflow.name} (${workflow.path})`,
      value: workflow,
    })),
  );
  output.status(`Selected workflow ${choice.name} (${choice.path}).`);
  return choice;
}

async function promptChoice<T>(
  prompt: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> {
  const lines = options.map((option, index) => `  ${index + 1}. ${option.label}`);
  process.stderr.write(`${prompt}\n${lines.join("\n")}\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    while (true) {
      const answer = (await rl.question("Select workflow by number: ")).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) {
        return options[index].value;
      }

      process.stderr.write("Invalid selection. Enter one of the listed numbers.\n");
    }
  } finally {
    rl.close();
  }
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

async function listRepositoryRunsWithRetry(
  api: GitHubApiClient,
  filters: { branch?: string; headSha?: string },
): Promise<GitHubRun[]> {
  const fetchSortedRepositoryRuns = (requestFilters: { branch?: string; headSha?: string }) =>
    api.listRepositoryRuns(requestFilters).then(sortRuns);

  return retryRunDiscovery(filters, fetchSortedRepositoryRuns);
}

async function listRunsWithRetry(
  api: GitHubApiClient,
  workflowId: number,
  filters: { branch?: string; headSha?: string },
): Promise<GitHubRun[]> {
  const fetchSortedWorkflowRuns = (requestFilters: { branch?: string; headSha?: string }) =>
    api.listWorkflowRuns(workflowId, requestFilters).then(sortRuns);

  return retryRunDiscovery(filters, fetchSortedWorkflowRuns);
}

async function retryRunDiscovery(
  initialFilters: { branch?: string; headSha?: string },
  fetchSortedRuns: (requestFilters: { branch?: string; headSha?: string }) => Promise<GitHubRun[]>,
): Promise<GitHubRun[]> {
  for (let attempt = 0; attempt < RUN_DISCOVERY_RETRY_ATTEMPTS; attempt += 1) {
    const runs = await fetchSortedRuns(initialFilters);
    if (runs.length > 0) {
      return runs;
    }

    if (attempt < RUN_DISCOVERY_RETRY_ATTEMPTS - 1 && initialFilters.headSha) {
      await sleep(RUN_DISCOVERY_RETRY_DELAY_MS);
      continue;
    }

    if (!initialFilters.branch || !initialFilters.headSha) {
      return runs;
    }

    const fallbackFilters = { headSha: initialFilters.headSha };
    return fetchSortedRuns(fallbackFilters);
  }

  return [];
}

function sortRuns(runs: readonly GitHubRun[]): GitHubRun[] {
  return [...runs].sort((left, right) => {
    const createdDiff =
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    if (createdDiff !== 0) {
      return createdDiff;
    }

    if (right.runAttempt !== left.runAttempt) {
      return right.runAttempt - left.runAttempt;
    }

    return right.id - left.id;
  });
}

function pickLatestRun(runs: readonly GitHubRun[]): GitHubRun {
  return sortRuns(runs)[0];
}

function resolveRepo(
  explicitRepo: string | undefined,
  repoFromUrl: string | undefined,
  repoFromGit: string | undefined,
): string | undefined {
  if (explicitRepo && repoFromUrl && explicitRepo !== repoFromUrl) {
    throw new Error(
      `The GitHub Actions URL points to ${repoFromUrl}, but --repo was ${explicitRepo}. Pass only one repository source.`,
    );
  }

  return explicitRepo ?? repoFromUrl ?? repoFromGit;
}

async function readGitContext(cwd: string): Promise<GitContext> {
  const repo = await inferGitHubRepo(cwd);
  if (!repo) {
    return {};
  }

  return {
    repo,
    headSha: await getHeadCommit(cwd),
    branch: await getCurrentBranch(cwd),
  };
}

async function resolveCommitSelector(
  selector: string,
  cwd: string,
  canUseGit: boolean,
): Promise<string> {
  if (/^[0-9a-f]{40}$/iu.test(selector)) {
    return selector;
  }

  if (/^[0-9a-f]{7,39}$/iu.test(selector) && canUseGit) {
    const resolved = await resolveCommitish(cwd, selector);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(
    `Could not resolve "${selector}" to a commit SHA. Pass a full commit SHA, a GitHub Actions URL, or use --run-id.`,
  );
}

function buildNoRunsMessage(
  repo: string,
  headSha?: string,
  branch?: string,
  workflow?: GitHubWorkflow,
): string {
  const scope = [
    workflow ? `workflow ${workflow.name} (${workflow.path})` : undefined,
    headSha ? `commit ${headSha}` : undefined,
    branch ? `branch ${branch}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return `No GitHub Actions runs matched ${scope || "the current selection"} in ${repo}. Check the Actions tab or rerun with --run-id if you already know the run.`;
}

function buildWorkflowNotFoundMessage(
  workflowSelector: string,
  workflows: readonly GitHubWorkflow[],
): string {
  const available = workflows
    .map((workflow) => `  - ${workflow.name} (${workflow.path})`)
    .join("\n");

  return `No workflow matched "${workflowSelector}". Available workflows:\n${available}\nRerun with --workflow using one of the names or paths above.`;
}

function buildWorkflowAmbiguityMessage(
  workflowSelector: string,
  matches: readonly GitHubWorkflow[],
): string {
  const available = matches
    .map((workflow) => `  - ${workflow.name} (${workflow.path})`)
    .join("\n");

  return `Multiple workflows matched "${workflowSelector}". Matching workflows:\n${available}\nRerun with an exact workflow path like --workflow ${JSON.stringify(matches[0].path)}.`;
}

async function getRunWithFriendlyErrors(
  api: GitHubApiClient,
  runId: string,
  repo: string,
): Promise<GitHubRun> {
  try {
    return await api.getRun(runId);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      throw new Error(
        `GitHub can access ${repo}, but workflow run ${runId} was not found there. Verify the run URL or rerun with --repo owner/repo if the run belongs to another repository.`,
      );
    }

    throw error;
  }
}
