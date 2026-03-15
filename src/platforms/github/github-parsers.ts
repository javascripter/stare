export interface GitHubBackscrollLine {
  id: string;
  line: string;
}

export function parseGitHubBackscrollLines(payload: string): GitHubBackscrollLine[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.lines)) {
    return [];
  }

  return parsed.lines
    .map((entry) =>
      isRecord(entry) && typeof entry.id === "string" && typeof entry.line === "string"
        ? { id: entry.id, line: entry.line }
        : undefined,
    )
    .filter((entry): entry is GitHubBackscrollLine => entry !== undefined);
}

export interface GitHubWorkerLine {
  id: string;
  line: string;
}

export interface GitHubWorkerEvent {
  type: string;
  payload: unknown;
}

export function hasActionsResultsSubscription(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.subscribe)) {
    return false;
  }

  return payload.subscribe.some(
    (entry) =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      entry.name.startsWith("actions_results:"),
  );
}

export function parseActionsResultsLines(payload: unknown): GitHubWorkerLine[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (typeof payload.channel !== "string" || !payload.channel.startsWith("actions_results:")) {
    return [];
  }

  const data = payload.data;
  if (!isRecord(data)) {
    return [];
  }

  const nested = data.data;
  if (!isRecord(nested) || !Array.isArray(nested.lines)) {
    return [];
  }

  return nested.lines
    .map((entry) =>
      isRecord(entry) && typeof entry.lineID === "string" && typeof entry.line === "string"
        ? { id: entry.lineID, line: entry.line }
        : undefined,
    )
    .filter((entry): entry is GitHubWorkerLine => entry !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
