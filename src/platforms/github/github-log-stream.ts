import type { BrowserContext, Page } from "playwright-core";
import type { OutputSink } from "../../core/output.js";
import {
  hasActionsResultsSubscription,
  parseGitHubBackscrollLines,
  parseActionsResultsLines,
  type GitHubWorkerEvent,
} from "./github-parsers.js";

export interface GitHubLiveJob {
  id: number;
  name: string;
  htmlUrl: string;
}

export class GitHubJobLogStream {
  private page?: Page;
  private closed = false;
  private attached = false;
  private readonly seenLineIds = new Set<string>();
  private readonly ready = createDeferred<void>();
  private readonly finishedResolver = createDeferred<void>();

  public lastMessageAt = Date.now();
  public emittedLineCount = 0;
  public readonly finished = this.finishedResolver.promise;
  private static readonly workerEventPrefix = "__watch_github_worker__";
  private static readonly workerHookScript = `
(() => {
  const report = (type, payload) => {
    console.debug("__watch_github_worker__" + JSON.stringify({ type, payload }));
  };

  const OriginalSharedWorker = globalThis.SharedWorker;
  if (!OriginalSharedWorker) {
    return;
  }

  globalThis.SharedWorker = class extends OriginalSharedWorker {
    constructor(url, options) {
      super(url, options);

      const originalPostMessage = this.port.postMessage.bind(this.port);
      this.port.postMessage = (...args) => {
        const [data] = args;
        report("shared-worker-post", data);
        return originalPostMessage(...args);
      };

      this.port.addEventListener("message", (event) => {
        report("shared-worker-message", event.data);
      });

      this.port.start?.();
    }
  };
})();
`;

  constructor(
    private readonly context: BrowserContext,
    private readonly job: GitHubLiveJob,
    private readonly output: OutputSink,
    private readonly streamAttachTimeoutMs: number,
  ) {}

  async start(): Promise<void> {
    this.page = await this.context.newPage();
    this.page.on("console", (message) => {
      const text = message.text();
      if (!text.startsWith(GitHubJobLogStream.workerEventPrefix)) {
        return;
      }

      try {
        const event = JSON.parse(
          text.slice(GitHubJobLogStream.workerEventPrefix.length),
        ) as GitHubWorkerEvent;
        this.handleWorkerEvent(event);
      } catch {
        return;
      }
    });
    await this.page.addInitScript({ content: GitHubJobLogStream.workerHookScript });
    this.attachPageHandlers(this.page);
    await this.page.goto(this.job.htmlUrl, { waitUntil: "domcontentloaded" });

    await Promise.race([
      this.ready.promise,
      waitFor(this.streamAttachTimeoutMs).then(() => {
        throw new Error(
          `Timed out waiting for GitHub live logs for job "${this.job.name}".`,
        );
      }),
      this.finished,
    ]);

    if (!this.attached) {
      throw new Error(
        `The GitHub job page did not expose a readable live log stream for "${this.job.name}".`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.page && !this.page.isClosed()) {
      await this.page.close();
    }
    this.finishedResolver.resolve();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private attachPageHandlers(page: Page): void {
    page.on("close", () => {
      this.closed = true;
      this.finishedResolver.resolve();
    });

    page.on("pageerror", (error) => {
      this.output.error(`Page error while watching ${this.job.name}: ${error.message}`);
    });

    page.on("response", async (response) => {
      if (!isGitHubBackscrollUrl(response.url(), this.job.htmlUrl)) {
        return;
      }

      const payload = await safeReadResponseText(response);
      if (payload === undefined) {
        return;
      }

      const lines = parseGitHubBackscrollLines(payload);
      if (!this.attached) {
        this.attached = true;
        this.ready.resolve();
      }

      const freshLines = lines
        .filter((line) => !this.seenLineIds.has(line.id))
        .map((line) => {
          this.seenLineIds.add(line.id);
          return line.line;
        });

      if (freshLines.length === 0) {
        return;
      }

      this.lastMessageAt = Date.now();
      this.emittedLineCount += freshLines.length;
      this.output.writeLines(this.job.name, freshLines);
    });
  }

  private handleWorkerEvent(event: GitHubWorkerEvent): void {
    if (event.type === "shared-worker-post" && hasActionsResultsSubscription(event.payload)) {
      this.markAttached();
      return;
    }

    if (event.type !== "shared-worker-message") {
      return;
    }

    const freshLines = parseActionsResultsLines(event.payload)
      .filter((line) => !this.seenLineIds.has(line.id))
      .map((line) => {
        this.seenLineIds.add(line.id);
        return line.line;
      });

    if (freshLines.length === 0) {
      return;
    }

    this.markAttached();
    this.lastMessageAt = Date.now();
    this.emittedLineCount += freshLines.length;
    this.output.writeLines(this.job.name, freshLines);
  }

  private markAttached(): void {
    if (this.attached) {
      return;
    }

    this.attached = true;
    this.ready.resolve();
  }
}

async function safeReadResponseText(response: { text(): Promise<string> }): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function isGitHubBackscrollUrl(url: string, jobHtmlUrl: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const parsedJobUrl = new URL(jobHtmlUrl);
    const expectedPrefix = parsedJobUrl.pathname.replace(/\/job\/\d+$/u, "/jobs/");

    return (
      parsedUrl.hostname === parsedJobUrl.hostname &&
      parsedUrl.pathname.startsWith(expectedPrefix) &&
      parsedUrl.pathname.includes("/steps/") &&
      parsedUrl.pathname.endsWith("/backscroll")
    );
  } catch {
    return false;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
