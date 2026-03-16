import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { OutputSink } from "../../core/output.js";

export interface GitHubBrowserOptions {
  headed: boolean;
  storageStatePath: string;
  browserChannel?: string;
  browserPath?: string;
  loginTimeoutMs: number;
  allowInteractiveLogin?: boolean;
}

export interface GitHubBrowserSession {
  browser: Browser;
  context: BrowserContext;
  close(): Promise<void>;
}

export async function createGitHubBrowserSession(
  options: GitHubBrowserOptions,
  output: OutputSink,
): Promise<GitHubBrowserSession> {
  const hasPersistedState = await hasStorageState(options.storageStatePath);
  if (hasPersistedState) {
    const authenticated = await hasAuthenticatedStorageState(options);
    if (!authenticated) {
      if (!options.allowInteractiveLogin) {
        throw new GitHubAuthRequiredError(
          `GitHub browser session for live log streaming is missing or expired at ${options.storageStatePath}. Run \`stare gh auth login\` in an interactive terminal to create or refresh it.`,
        );
      }

      output.status(
        `GitHub browser session for live log streaming is missing or expired. Opening a browser window to refresh ${options.storageStatePath}.`,
      );
      await refreshGitHubBrowserSession(options, output);
    }
  } else if (options.allowInteractiveLogin) {
    output.status(
      `GitHub browser session for live log streaming is missing or expired. Opening a browser window to refresh ${options.storageStatePath}.`,
    );
    await refreshGitHubBrowserSession(options, output);
  } else {
    throw new GitHubAuthRequiredError(
      `GitHub browser session for live log streaming is missing or expired at ${options.storageStatePath}. Run \`stare gh auth login\` in an interactive terminal to create or refresh it.`,
    );
  }

  const browser = await chromium.launch({
    channel: options.browserPath ? undefined : options.browserChannel,
    executablePath: options.browserPath,
    headless: !options.headed,
  });

  const context = await browser.newContext({
    storageState: options.storageStatePath,
  });

  try {
    const page = await context.newPage();
    try {
      if (!(await isAuthenticated(page))) {
        throw new GitHubAuthRequiredError(
          `GitHub browser session for live log streaming could not be restored from ${options.storageStatePath}. Run \`stare gh auth login\` and try again.`,
        );
      }
    } finally {
      await page.close();
    }
  } catch (error) {
    await context.close();
    await browser.close();
    throw error;
  }

  return {
    browser,
    context,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

export async function loginToGitHub(
  options: Omit<GitHubBrowserOptions, "headed" | "allowInteractiveLogin">,
  output: OutputSink,
): Promise<void> {
  await refreshGitHubBrowserSession(
    {
      ...options,
      headed: true,
      allowInteractiveLogin: true,
    },
    output,
  );
}

async function refreshGitHubBrowserSession(
  options: GitHubBrowserOptions,
  output: OutputSink,
): Promise<void> {
  const browser = await chromium.launch({
    channel: options.browserPath ? undefined : options.browserChannel,
    executablePath: options.browserPath,
    headless: false,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    if (!options.allowInteractiveLogin) {
      throw new GitHubAuthRequiredError(
        `GitHub browser session for live log streaming is missing or expired at ${options.storageStatePath}. Run \`stare gh auth login\` in an interactive terminal to create or refresh it.`,
      );
    }

    output.status(
      "GitHub login required for live log streaming. Complete the login flow in the opened browser window.",
    );

    await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" });
    await page.waitForURL(
      (url) =>
        url.hostname === "github.com" &&
        !url.pathname.startsWith("/login") &&
        !url.pathname.startsWith("/session"),
      { timeout: options.loginTimeoutMs },
    );

    await page.goto("https://github.com/settings/profile", { waitUntil: "domcontentloaded" });
    await persistStorageState(context, options.storageStatePath);
    output.status(
      `Saved GitHub browser session for live log streaming to ${options.storageStatePath}.`,
    );
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

async function hasAuthenticatedStorageState(options: GitHubBrowserOptions): Promise<boolean> {
  const browser = await chromium.launch({
    channel: options.browserPath ? undefined : options.browserChannel,
    executablePath: options.browserPath,
    headless: true,
  });
  const context = await browser.newContext({
    storageState: options.storageStatePath,
  });
  const page = await context.newPage();

  try {
    return await isAuthenticated(page);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

async function isAuthenticated(page: Page): Promise<boolean> {
  await page.goto("https://github.com/settings/profile", { waitUntil: "domcontentloaded" });
  const url = new URL(page.url());
  return url.hostname === "github.com" && url.pathname.startsWith("/settings");
}

async function persistStorageState(
  context: BrowserContext,
  storageStatePath: string,
): Promise<void> {
  await mkdir(dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
}

async function hasStorageState(storageStatePath: string): Promise<boolean> {
  try {
    await access(storageStatePath);
    return true;
  } catch {
    return false;
  }
}

export class GitHubAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthRequiredError";
  }
}
