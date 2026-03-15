import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function inferGitHubRepo(cwd: string): Promise<string | undefined> {
  const remotes = ["origin", "upstream"];

  for (const remote of remotes) {
    const repo = parseGitHubRepo(await getRemoteUrl(cwd, remote));
    if (repo) {
      return repo;
    }
  }

  const listedRemotes = await listRemoteNames(cwd);
  for (const remote of listedRemotes) {
    if (remotes.includes(remote)) {
      continue;
    }

    const repo = parseGitHubRepo(await getRemoteUrl(cwd, remote));
    if (repo) {
      return repo;
    }
  }

  return undefined;
}

export async function getHeadCommit(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveCommitish(cwd: string, value: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", `${value}^{commit}`], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseGitHubRepo(remoteUrl?: string): string | undefined {
  if (!remoteUrl) {
    return undefined;
  }

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  const httpsMatch = remoteUrl.match(
    /^https:\/\/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?(?:\/)?$/,
  );
  if (httpsMatch) {
    return httpsMatch[1];
  }

  const sshUrlMatch = remoteUrl.match(
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/,
  );
  if (sshUrlMatch) {
    return sshUrlMatch[1];
  }

  return undefined;
}

async function getRemoteUrl(cwd: string, remote: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", remote], { cwd });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function listRemoteNames(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote"], { cwd });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
