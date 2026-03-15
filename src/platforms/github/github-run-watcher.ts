import { setTimeout as sleep } from "node:timers/promises";
import type { OutputSink } from "../../core/output.js";
import { TerminalOutput as DefaultTerminalOutput } from "../../core/output.js";
import { expandHomeDirectory } from "../../utils/path.js";
import {
  createGitHubBrowserSession,
  type GitHubBrowserOptions,
  type GitHubBrowserSession,
} from "./github-auth.js";
import {
  type GitHubApiClient,
  type GitHubJob,
  type GitHubRun,
} from "./github-api.js";
import { GitHubJobLogStream } from "./github-log-stream.js";
import { GitHubFormattedOutput } from "./github-output.js";
import { resolveGitHubRuns, type GitHubResolveOptions } from "./github-run-resolver.js";

interface GitHubCommandOptions {
  repo?: string;
  token?: string;
  storageState: string;
  headed?: boolean;
  browserChannel?: string;
  browserPath?: string;
  pollIntervalMs: number;
  loginTimeoutMs: number;
  attachTimeoutMs: number;
  idleShutdownMs: number;
}

interface ObservedJobState {
  job: GitHubJob;
  stream?: GitHubJobLogStream;
  launchPromise?: Promise<void>;
  nextAttachAt: number;
  everAttached: boolean;
  liveLinesSeen: number;
  archivedPrinted: boolean;
}

interface CompletedJobSummary {
  label: string;
  conclusion: string | null;
  durationMs?: number;
}

interface RunSnapshot {
  run: GitHubRun;
  jobs: GitHubJob[];
  isRunCompleted: boolean;
  areAllJobsCompleted: boolean;
}

interface JobWatchContext {
  api: Pick<GitHubApiClient, "getJobLogs">;
  run: GitHubRun;
  options: GitHubCommandOptions;
  output: OutputSink;
  getBrowserSession: () => Promise<GitHubBrowserSession>;
  includeRunLabel: boolean;
}

export async function watchGitHub(
  resolveOptions: GitHubResolveOptions,
  options: GitHubCommandOptions,
  output: OutputSink = new DefaultTerminalOutput(),
): Promise<void> {
  const { api, repo, runs } = await resolveGitHubRuns(resolveOptions, output);
  const githubOutput = new GitHubFormattedOutput(output);
  printResolvedRuns(githubOutput, repo, runs);

  const abortController = new AbortController();
  const signal = abortController.signal;
  const onSignal = () => abortController.abort();

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const browserOptions: GitHubBrowserOptions = {
    headed: options.headed ?? false,
    storageStatePath: expandHomeDirectory(options.storageState),
    browserChannel: options.browserChannel,
    browserPath: options.browserPath,
    loginTimeoutMs: options.loginTimeoutMs,
    allowInteractiveLogin: isInteractiveTerminal(),
  };

  let browserSessionPromise: Promise<GitHubBrowserSession> | undefined;
  const completedJobs = new Map<string, CompletedJobSummary>();
  const getBrowserSession = (): Promise<GitHubBrowserSession> => {
    browserSessionPromise ??= createGitHubBrowserSession(browserOptions, githubOutput);
    return browserSessionPromise;
  };

  try {
    const results = await Promise.allSettled(
      runs.map((run) =>
        watchResolvedGitHubRun(
          api,
          repo,
          run,
          options,
          githubOutput,
          signal,
          getBrowserSession,
          runs.length > 1,
          completedJobs,
        ),
      ),
    );

    if (signal.aborted) {
      output.status("Stopping watcher.");
      return;
    }

    printCompletedJobFooter(output, completedJobs);

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));

    if (failures.length === 1) {
      throw new Error(failures[0]);
    }

    if (failures.length > 1) {
      throw new Error(`One or more GitHub runs failed:\n- ${failures.join("\n- ")}`);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (browserSessionPromise) {
      const browserResult = await Promise.allSettled([browserSessionPromise]);
      const browserSession = browserResult[0];
      if (browserSession.status === "fulfilled") {
        await browserSession.value.close();
      }
    }
  }
}

async function watchResolvedGitHubRun(
  api: Pick<GitHubApiClient, "getRun" | "listJobs" | "getJobLogs">,
  repo: string,
  run: GitHubRun,
  options: GitHubCommandOptions,
  output: OutputSink,
  signal: AbortSignal,
  getBrowserSession: () => Promise<GitHubBrowserSession>,
  includeRunLabel: boolean,
  completedJobs: Map<string, CompletedJobSummary>,
): Promise<void> {
  output.status(`Watching GitHub run ${run.id} in ${repo}.`);

  try {
    const jobStates = new Map<number, ObservedJobState>();
    const runId = String(run.id);

    while (!signal.aborted) {
      const snapshot = await pollRunSnapshot(api, runId);
      await reconcileObservedJobs(jobStates, snapshot, {
        api,
        run,
        options,
        output,
        getBrowserSession,
        includeRunLabel,
      });
      finalizeCompletedJobs(jobStates, snapshot, run, includeRunLabel, completedJobs);

      if (shouldFinishWatchingRun(snapshot, jobStates)) {
        completeWatchedRun(run, snapshot.run, output);
        return;
      }

      await sleep(options.pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      return;
    }

    throw error;
  }
}

async function pollRunSnapshot(
  api: Pick<GitHubApiClient, "getRun" | "listJobs">,
  runId: string,
): Promise<RunSnapshot> {
  const [run, jobs] = await Promise.all([api.getRun(runId), api.listJobs(runId)]);
  return {
    run,
    jobs,
    isRunCompleted: run.status === "completed",
    areAllJobsCompleted: jobs.every((job) => job.status === "completed"),
  };
}

async function reconcileObservedJobs(
  jobStates: Map<number, ObservedJobState>,
  snapshot: RunSnapshot,
  context: JobWatchContext,
): Promise<void> {
  for (const job of snapshot.jobs) {
    const state = getOrCreateJobState(jobStates, job);
    const jobLabel = formatJobLabel(context.run, state.job, context.includeRunLabel);

    await maybeStartJobStream(state, jobLabel, context);
    await maybeStopCompletedJobStream(state, context.options.idleShutdownMs);
    await maybePrintArchivedJobLogs(state, jobLabel, snapshot, context);
  }
}

function getOrCreateJobState(
  jobStates: Map<number, ObservedJobState>,
  job: GitHubJob,
): ObservedJobState {
  const state = jobStates.get(job.id) ?? {
    job,
    nextAttachAt: 0,
    everAttached: false,
    liveLinesSeen: 0,
    archivedPrinted: false,
  };

  state.job = job;
  jobStates.set(job.id, state);
  return state;
}

async function maybeStartJobStream(
  state: ObservedJobState,
  jobLabel: string,
  context: Pick<JobWatchContext, "options" | "output" | "getBrowserSession">,
): Promise<void> {
  if (
    state.job.status !== "in_progress" ||
    state.stream ||
    state.launchPromise ||
    Date.now() < state.nextAttachAt
  ) {
    return;
  }

  const browserSession = await context.getBrowserSession();
  state.launchPromise = launchJobStream(
    state,
    browserSession,
    context.output,
    context.options,
    jobLabel,
  );
}

async function maybeStopCompletedJobStream(
  state: ObservedJobState,
  idleShutdownMs: number,
): Promise<void> {
  if (!state.stream || state.job.status !== "completed") {
    return;
  }

  if (
    !shouldBackfillArchivedLogs(state) &&
    Date.now() - state.stream.lastMessageAt < idleShutdownMs
  ) {
    return;
  }

  await state.stream.stop();
  state.stream = undefined;
}

async function maybePrintArchivedJobLogs(
  state: ObservedJobState,
  jobLabel: string,
  snapshot: RunSnapshot,
  context: Pick<JobWatchContext, "api" | "output">,
): Promise<void> {
  if (
    !snapshot.isRunCompleted ||
    state.job.status !== "completed" ||
    state.archivedPrinted ||
    state.launchPromise ||
    !shouldBackfillArchivedLogs(state)
  ) {
    return;
  }

  await printArchivedJobLogs(context.api, state, context.output, jobLabel);
}

function finalizeCompletedJobs(
  jobStates: Map<number, ObservedJobState>,
  snapshot: RunSnapshot,
  run: GitHubRun,
  includeRunLabel: boolean,
  completedJobs: Map<string, CompletedJobSummary>,
): void {
  for (const [jobId, state] of jobStates) {
    if (state.stream?.isClosed) {
      state.stream = undefined;
    }

    if (!snapshot.isRunCompleted || !isJobStateSettled(state)) {
      continue;
    }

    updateCompletedJobSummary(
      completedJobs,
      formatJobLabel(run, state.job, includeRunLabel),
      state.job,
    );
    jobStates.delete(jobId);
  }
}

function isJobStateSettled(state: ObservedJobState): boolean {
  return state.job.status === "completed" && !state.stream && !state.launchPromise;
}

function shouldFinishWatchingRun(
  snapshot: RunSnapshot,
  jobStates: ReadonlyMap<number, ObservedJobState>,
): boolean {
  return (
    snapshot.isRunCompleted &&
    snapshot.areAllJobsCompleted &&
    [...jobStates.values()].every(isJobStateSettled)
  );
}

function completeWatchedRun(
  resolvedRun: GitHubRun,
  latestRun: GitHubRun,
  output: OutputSink,
): void {
  if (shouldFailForRunConclusion(latestRun.conclusion)) {
    throw new Error(
      `${formatRunLabel(resolvedRun)} completed with conclusion: ${latestRun.conclusion ?? "unknown"}.`,
    );
  }

  output.status(`${formatRunLabel(resolvedRun)} ${formatConclusionSymbol(latestRun.conclusion)}`);
}

async function launchJobStream(
  state: ObservedJobState,
  browserSession: GitHubBrowserSession,
  output: OutputSink,
  options: Pick<GitHubCommandOptions, "attachTimeoutMs" | "pollIntervalMs">,
  jobLabel: string,
): Promise<void> {
  const stream = new GitHubJobLogStream(
    browserSession.context,
    {
      id: state.job.id,
      name: jobLabel,
      htmlUrl: state.job.htmlUrl,
    },
    output,
    options.attachTimeoutMs,
  );

  state.stream = stream;

  try {
    await stream.start();
    state.everAttached = true;
    output.status(`Attached to ${jobLabel}.`);
    await stream.finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(`Failed to attach to ${jobLabel}: ${message}`);
    await stream.stop();
    state.nextAttachAt = Date.now() + options.pollIntervalMs;
  } finally {
    state.liveLinesSeen += stream.emittedLineCount;
    state.stream = undefined;
    state.launchPromise = undefined;
  }
}

async function printArchivedJobLogs(
  api: Pick<GitHubApiClient, "getJobLogs">,
  state: ObservedJobState,
  output: OutputSink,
  jobLabel: string,
): Promise<void> {
  const rawLogs = await api.getJobLogs(state.job.id);
  const lines = rawLogs
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);

  if (lines.length > 0) {
    output.status(`Fetched archived logs for ${jobLabel}.`);
    output.writeLines(jobLabel, lines);
  }

  state.archivedPrinted = true;
}

function printResolvedRuns(
  output: OutputSink,
  repo: string,
  runs: readonly GitHubRun[],
): void {
  if (runs.length === 1) {
    const [run] = runs;
    output.status(`Resolved run: ${run.id} in ${repo}.`);
    output.status(`Workflow: ${run.name} (${run.path})`);
    output.status(`Branch: ${run.headBranch}`);
    output.status(`Commit: ${run.headSha}`);
    output.status(`Status: ${formatRunStatus(run)}`);
    return;
  }

  output.status(`Resolved ${runs.length} runs in ${repo}.`);
  for (const run of runs) {
    output.status(
      `${formatRunLabel(run)} branch=${run.headBranch} commit=${run.headSha} status=${formatRunStatus(run)}`,
    );
  }
}

function formatRunStatus(run: GitHubRun): string {
  return run.status === "completed"
    ? `${run.status}/${run.conclusion ?? "unknown"}`
    : run.status;
}

export function shouldFailForRunConclusion(
  conclusion: string | null,
): boolean {
  return !ZERO_EXIT_CONCLUSIONS.has(conclusion);
}

export function shouldBackfillArchivedLogs(state: {
  everAttached: boolean;
  liveLinesSeen: number;
  stream?: { emittedLineCount: number };
}): boolean {
  return !state.everAttached || totalLiveLinesSeen(state) === 0;
}

function totalLiveLinesSeen(state: {
  liveLinesSeen: number;
  stream?: { emittedLineCount: number };
}): number {
  return state.liveLinesSeen + (state.stream?.emittedLineCount ?? 0);
}

const ZERO_EXIT_CONCLUSIONS = new Set<string | null>(["success", "neutral", "skipped"]);

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function formatRunLabel(run: GitHubRun): string {
  return `${run.name}#${run.runNumber}`;
}

function formatJobLabel(
  run: GitHubRun,
  job: GitHubJob,
  includeRunLabel: boolean,
): string {
  return includeRunLabel ? `${formatRunLabel(run)}/${job.name}` : job.name;
}

function updateCompletedJobSummary(
  completedJobs: Map<string, CompletedJobSummary>,
  label: string,
  job: GitHubJob,
): void {
  completedJobs.set(label, {
    label,
    conclusion: job.conclusion,
    durationMs: getJobDurationMs(job),
  });
}

function printCompletedJobFooter(
  output: OutputSink,
  completedJobs: Map<string, CompletedJobSummary>,
): void {
  if (completedJobs.size === 0) {
    return;
  }

  output.status(`Summary: ${completedJobs.size} job${completedJobs.size === 1 ? "" : "s"}`);
  for (const summary of [...completedJobs.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  )) {
    output.status(
      `  ${formatConclusionSymbol(summary.conclusion)} ${summary.label}${formatDurationSuffix(summary.durationMs)}`,
    );
  }
}

function formatConclusionSymbol(conclusion: string | null): string {
  return shouldFailForRunConclusion(conclusion) ? "✗" : "✓";
}

function getJobDurationMs(job: GitHubJob): number | undefined {
  if (!job.startedAt || !job.completedAt) {
    return undefined;
  }

  const startedAt = new Date(job.startedAt).getTime();
  const completedAt = new Date(job.completedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    return undefined;
  }

  return completedAt - startedAt;
}

function formatDurationSuffix(durationMs?: number): string {
  if (durationMs === undefined) {
    return "";
  }

  return ` ${formatDuration(durationMs)}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${totalSeconds}s`;
  }

  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
