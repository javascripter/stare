import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveGitHubToken(cwd: string): Promise<string> {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { cwd });
    const token = stdout.trim();
    if (token) {
      return token;
    }

    throw new Error(
      "GitHub authentication is required. stare first checks GITHUB_TOKEN, then `gh auth token`. `gh auth token` returned an empty token. Run `gh auth login`, or pass --token / set GITHUB_TOKEN explicitly.",
    );
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stderr?: string };
    if (execError.code === "ENOENT") {
      throw new Error(
        "GitHub authentication is required. stare first checks GITHUB_TOKEN, then `gh auth token`, but the GitHub CLI (`gh`) is not installed or not on PATH. Set GITHUB_TOKEN, pass --token, or install GitHub CLI and run `gh auth login`.",
      );
    }

    const stderr = execError.stderr?.trim();
    throw new Error(
      stderr
        ? `GitHub authentication is required. stare first checks GITHUB_TOKEN, then \`gh auth token\`. \`gh auth token\` failed: ${stderr}. Run \`gh auth login\`, or pass --token / set GITHUB_TOKEN explicitly.`
        : "GitHub authentication is required. stare first checks GITHUB_TOKEN, then `gh auth token`. `gh auth token` failed. Run `gh auth login`, or pass --token / set GITHUB_TOKEN explicitly.",
    );
  }
}
