import type { Command } from "commander";
import type { WatchPlatform } from "../../core/platform.js";
import { TerminalOutput } from "../../core/output.js";
import { expandHomeDirectory } from "../../utils/path.js";
import { loginToGitHub } from "./github-auth.js";
import { watchGitHub } from "./github-run-watcher.js";

const DEFAULT_STORAGE_STATE = "~/.stare/github/storage-state.json";

interface GitHubBrowserCommandOptions {
  storageState: string;
  browserChannel?: string;
  browserPath?: string;
  loginTimeoutMs: number;
}

interface GitHubRunViewOptions extends GitHubBrowserCommandOptions {
  repo?: string;
  token?: string;
  headed?: boolean;
  pollIntervalMs: number;
  attachTimeoutMs: number;
  idleShutdownMs: number;
  runId: string[];
  workflow?: string;
}

export const githubPlatform: WatchPlatform = {
  name: "gh",
  description: "GitHub Actions tools.",
  register(program: Command) {
    const gh = program
      .command("gh")
      .description("GitHub Actions tools.")
      .action(() => {
        gh.help();
      });

    const auth = gh
      .command("auth")
      .description("Authenticate browser access to GitHub.")
      .action(() => {
        auth.help();
      });

    auth
      .command("login")
      .description("Authenticate the GitHub browser session used for live log streaming.")
      .option(
        "--storage-state <path>",
        "Path to the saved Playwright storage state",
        process.env.STARE_GITHUB_STORAGE_STATE ?? DEFAULT_STORAGE_STATE,
      )
      .option(
        "--browser-channel <channel>",
        "Browser channel to launch with Playwright",
        process.env.STARE_BROWSER_CHANNEL ?? "chrome",
      )
      .option(
        "--browser-path <path>",
        "Explicit browser executable path",
        process.env.STARE_BROWSER_PATH,
      )
      .option(
        "--login-timeout-ms <ms>",
        "How long to wait for a manual GitHub login",
        parseNumberOption,
        180_000,
      )
      .addHelpText(
        "after",
        `
Examples:
  $ stare gh auth login
  $ stare gh auth login --storage-state ~/.stare/github/storage-state.json
`,
      )
      .action(async (options: GitHubBrowserCommandOptions) => {
        ensureInteractiveTerminal(
          "GitHub browser login requires an interactive terminal. Run `stare gh auth login` from an interactive shell.",
        );

        await loginToGitHub(
          {
            storageStatePath: expandHomeDirectory(options.storageState),
            browserChannel: options.browserChannel,
            browserPath: options.browserPath,
            loginTimeoutMs: options.loginTimeoutMs,
          },
          new TerminalOutput(),
        );
      });

    const run = gh
      .command("run")
      .description("View and follow GitHub Actions runs.")
      .action(() => {
        run.help();
      });

    const view = run
      .command("view")
      .description("View and follow GitHub Actions logs for a workflow run.")
      .argument(
        "[selector]",
        "Run ID, commit SHA, or GitHub Actions URL. Omit to use the latest eligible runs for the current HEAD commit.",
      );

    addRunViewOptions(view)
      .addHelpText(
        "after",
        `
Examples:
  $ stare gh run view
  $ stare gh run view 23115990238
  $ stare gh run view 2ce6a27
  $ stare gh run view --workflow debug.yml
  $ stare gh run view https://github.com/owner/repo/actions/runs/23115990238

Selection rules:
  - No selector: use the latest eligible run for each workflow on the current HEAD commit.
  - Run ID: use that run directly.
  - Commit SHA: use the latest eligible run for each matching workflow, preferring the current branch.
  - --workflow: use the latest run for that workflow, scoped to the current branch when possible.
  - Without --workflow, matching workflows stream together.
`,
      )
      .action(async (selector: string | undefined, options: GitHubRunViewOptions) => {
        await watchGitHub(
          {
            selector,
            repo: options.repo,
            runId: options.runId.length > 0 ? options.runId : undefined,
            token: options.token,
            workflow: options.workflow,
          },
          options,
        );
      });

  },
};

function addRunViewOptions(command: Command): Command {
  return command
    .option("-R, --repo <owner/repo>", "GitHub repository to stare at")
    .option("--run-id <run-id>", "GitHub Actions run ID", collectValues, [])
    .option(
      "--workflow <workflow>",
      "Workflow name, file name, or workflow path. Defaults to the current branch when possible.",
    )
    .option("--token <token>", "GitHub API token", process.env.GITHUB_TOKEN)
    .option(
      "--storage-state <path>",
      "Path to the saved Playwright storage state",
      process.env.STARE_GITHUB_STORAGE_STATE ?? DEFAULT_STORAGE_STATE,
    )
    .option("--headed", "Launch a visible browser instead of running headless")
    .option(
      "--browser-channel <channel>",
      "Browser channel to launch with Playwright",
      process.env.STARE_BROWSER_CHANNEL ?? "chrome",
    )
    .option(
      "--browser-path <path>",
      "Explicit browser executable path",
      process.env.STARE_BROWSER_PATH,
    )
    .option(
      "--poll-interval-ms <ms>",
      "Workflow/job polling interval in milliseconds",
      parseNumberOption,
      3_000,
    )
    .option(
      "--login-timeout-ms <ms>",
      "How long to wait for a manual GitHub login",
      parseNumberOption,
      180_000,
    )
    .option(
      "--attach-timeout-ms <ms>",
      "How long to wait for the page to attach to a live log stream",
      parseNumberOption,
      45_000,
    )
    .option(
      "--idle-shutdown-ms <ms>",
      "How long to keep a completed job stream open after the last log frame",
      parseNumberOption,
      5_000,
    );
}

function collectValues(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric option: ${value}`);
  }

  return parsed;
}

function ensureInteractiveTerminal(message: string): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(message);
  }
}
