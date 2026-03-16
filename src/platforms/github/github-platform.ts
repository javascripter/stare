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
  login?: boolean;
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
    configureGitHubWatchCommand(program, {
      root: true,
      examples: [
        "$ stare",
        "$ stare 23115990238",
        "$ stare 2ce6a27",
        "$ stare --workflow debug.yml",
        "$ stare https://github.com/owner/repo/actions/runs/23115990238",
        "$ stare --login",
      ],
    });

    const gh = program
      .command("gh")
      .description("View and follow GitHub Actions logs.");

    configureGitHubWatchCommand(gh, {
      examples: [
        "$ stare gh",
        "$ stare gh 23115990238",
        "$ stare gh 2ce6a27",
        "$ stare gh --workflow debug.yml",
        "$ stare gh https://github.com/owner/repo/actions/runs/23115990238",
        "$ stare gh --login",
      ],
    });
  },
};

function configureGitHubWatchCommand(
  command: Command,
  options: {
    root?: boolean;
    examples: readonly string[];
  },
): void {
  command
    .description(options.root ? "View and follow GitHub Actions logs." : command.description() ?? "")
    .argument(
      "[selector]",
      "Run ID, commit SHA, or GitHub Actions URL. Omit to use the latest eligible runs for the current HEAD commit.",
    );

  addRunViewOptions(command)
    .addHelpText(
      "after",
      `
Examples:
  ${options.examples.join("\n  ")}

Selection rules:
  - No selector: use the latest eligible run for each workflow on the current HEAD commit.
  - Run ID: use that run directly.
  - Commit SHA: use the latest eligible run for each matching workflow, preferring the current branch.
  - --workflow: use the latest run for that workflow, scoped to the current branch when possible.
  - Without --workflow, matching workflows stream together.
`,
    )
    .action(async (selector: string | undefined, commandOptions: GitHubRunViewOptions) => {
      if (commandOptions.login) {
        ensureInteractiveTerminal(
          "GitHub browser login requires an interactive terminal. Run `stare gh --login` from an interactive shell.",
        );

        if (selector || commandOptions.runId.length > 0 || commandOptions.workflow) {
          throw new Error(
            "Received --login together with a run selector. Use --login by itself to refresh the GitHub browser session.",
          );
        }

        await loginToGitHub(
          {
            storageStatePath: expandHomeDirectory(commandOptions.storageState),
            browserChannel: commandOptions.browserChannel,
            browserPath: commandOptions.browserPath,
            loginTimeoutMs: commandOptions.loginTimeoutMs,
          },
          new TerminalOutput(),
        );
        return;
      }

      await watchGitHub(
        {
          selector,
          repo: commandOptions.repo,
          runId: commandOptions.runId.length > 0 ? commandOptions.runId : undefined,
          token: commandOptions.token,
          workflow: commandOptions.workflow,
        },
        commandOptions,
      );
    });
}

function addRunViewOptions(command: Command): Command {
  return command
    .option("-R, --repo <owner/repo>", "GitHub repository to stare at")
    .option("--run-id <run-id>", "GitHub Actions run ID", collectValues, [])
    .option(
      "--workflow <workflow>",
      "Workflow name, file name, or workflow path. Defaults to the current branch when possible.",
    )
    .option("--login", "Create or refresh the GitHub browser session used for live log streaming")
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
