import { setTimeout as sleep } from "node:timers/promises";
import pc from "picocolors";
import type { OutputSink } from "../../core/output.js";
import { TerminalOutput as DefaultTerminalOutput } from "../../core/output.js";
import { ExpoApiClient, type EasBuild, type EasBuildApi } from "./eas-api.js";
import { resolveEasBuildSelector } from "./eas-build-selector.js";

interface EasBuildViewOptions {
  pollIntervalMs: number;
}

interface ObservedLogFile {
  emittedLineCount: number;
  phase?: string;
}

interface EasBuildLogState {
  announcedPhase?: string;
}

interface EasLogEntry {
  marker?: string;
  phase?: string;
  msg?: string;
  source?: string;
}

const EAS_PHASE_LABELS: Record<string, string> = {
  UNKNOWN: "Unknown build phase",
  QUEUE: "Waiting to start",
  SPIN_UP_BUILDER: "Spin up build environment",
  SET_UP_BUILD_ENVIRONMENT: "Set up build environment",
  BUILDER_INFO: "Builder environment info",
  START_BUILD: "Start build",
  INSTALL_CUSTOM_TOOLS: "Install custom tools",
  PREPARE_PROJECT: "Prepare project",
  RESTORE_CACHE: "Restore cache",
  INSTALL_DEPENDENCIES: "Install dependencies",
  EAS_BUILD_INTERNAL: "Resolve build configuration",
  PREBUILD: "Prebuild",
  PREPARE_CREDENTIALS: "Prepare credentials",
  CONFIGURE_ANDROID_VERSION: "Configure Android version",
  CALCULATE_EXPO_UPDATES_RUNTIME_VERSION: "Calculate expo-updates runtime version",
  CONFIGURE_EXPO_UPDATES: "Configure expo-updates",
  EAGER_BUNDLE: "Bundle JavaScript",
  SAVE_CACHE: "Save cache",
  CACHE_STATS: "Cache stats",
  UPLOAD_ARTIFACTS: "Upload artifacts",
  UPLOAD_APPLICATION_ARCHIVE: "Upload application archive",
  UPLOAD_BUILD_ARTIFACTS: "Upload build artifacts",
  PREPARE_ARTIFACTS: "Prepare artifacts",
  CLEAN_UP_CREDENTIALS: "Clean up credentials",
  COMPLETE_BUILD: "Complete build",
  FAIL_BUILD: "Fail job",
  READ_APP_CONFIG: "Read app config",
  READ_PACKAGE_JSON: "Read package.json",
  READ_EAS_JSON: "Read eas.json",
  RUN_EXPO_DOCTOR: "Run expo doctor",
  DOWNLOAD_APPLICATION_ARCHIVE: "Download application archive",
  FIX_GRADLEW: "Fix gradlew",
  RUN_GRADLEW: "Run gradlew",
  INSTALL_PODS: "Install pods",
  CONFIGURE_XCODE_PROJECT: "Configure Xcode project",
  RUN_FASTLANE: "Run fastlane",
  PRE_INSTALL_HOOK: "Pre-install hook",
  POST_INSTALL_HOOK: "Post-install hook",
  PRE_UPLOAD_ARTIFACTS_HOOK: "Pre-upload-artifacts hook",
  ON_BUILD_SUCCESS_HOOK: "Build success hook",
  ON_BUILD_ERROR_HOOK: "Build error hook",
  ON_BUILD_COMPLETE_HOOK: "Build complete hook",
  ON_BUILD_CANCEL_HOOK: "Build cancel hook",
  CUSTOM: "Unknown build phase",
  PARSE_CUSTOM_WORKFLOW_CONFIG: "Parse custom build config",
  COMPLETE_JOB: "Complete job",
};

export async function watchEasBuild(
  selectorInput: string,
  options: EasBuildViewOptions,
  output: OutputSink = new DefaultTerminalOutput(),
  api?: EasBuildApi,
): Promise<void> {
  const selector = resolveEasBuildSelector(selectorInput);
  const easApi = api ?? (await ExpoApiClient.fromEnvironment());

  const observedLogFiles = new Map<string, ObservedLogFile>();
  const buildLogState: EasBuildLogState = {};
  let printedHeader = false;
  let lastStatus: string | undefined;

  while (true) {
    const build = await easApi.getBuild(selector.buildId);

    if (!printedHeader) {
      printBuildHeader(build, selector.buildUrl, output);
      printedHeader = true;
    }

    if (build.status !== lastStatus) {
      output.status(`Build status: ${formatToken(build.status)}.`);
      lastStatus = build.status;
    }

    await reconcileLogFiles(build, observedLogFiles, buildLogState, easApi, output);

    if (isTerminalStatus(build.status)) {
      const finalBuild = await easApi.getBuild(selector.buildId);
      await reconcileLogFiles(finalBuild, observedLogFiles, buildLogState, easApi, output);
      finishBuild(finalBuild, output);
      return;
    }

    await sleep(options.pollIntervalMs);
  }
}

async function reconcileLogFiles(
  build: EasBuild,
  observedLogFiles: Map<string, ObservedLogFile>,
  buildLogState: EasBuildLogState,
  api: EasBuildApi,
  output: OutputSink,
): Promise<void> {
  const buildLabel = formatBuildLabel(build);

  for (const logFileUrl of build.logFiles) {
    const logFileKey = getLogFileKey(logFileUrl);
    const state = observedLogFiles.get(logFileKey) ?? { emittedLineCount: 0 };
    const entries = parseEasLogEntries(await api.getLogFile(logFileUrl));

    if (entries.length < state.emittedLineCount) {
      state.emittedLineCount = 0;
    }

    emitFreshLogEntries(
      entries.slice(state.emittedLineCount),
      state,
      buildLogState,
      buildLabel,
      output,
    );
    state.emittedLineCount = entries.length;
    observedLogFiles.set(logFileKey, state);
  }
}

function emitFreshLogEntries(
  entries: readonly EasLogEntry[],
  state: ObservedLogFile,
  buildLogState: EasBuildLogState,
  buildLabel: string,
  output: OutputSink,
): void {
  const renderedLines: string[] = [];

  for (const entry of entries) {
    if (entry.phase) {
      state.phase = entry.phase;
    }

    const phase = entry.phase ?? state.phase;
    if (phase && buildLogState.announcedPhase !== phase) {
      renderedLines.push(pc.bold(formatPhaseLabel(phase)));
      buildLogState.announcedPhase = phase;
    }

    const renderedLine = renderLogLine(entry);

    if (!renderedLine) {
      continue;
    }

    renderedLines.push(renderedLine);
  }

  if (renderedLines.length === 0) {
    return;
  }

  output.writeLines(buildLabel, renderedLines);
}

function renderLogLine(entry: EasLogEntry): string | undefined {
  if (entry.marker === "START_PHASE" || entry.marker === "END_PHASE") {
    return undefined;
  }

  const markerLine = renderMarkerLine(entry);
  if (markerLine) {
    return markerLine;
  }

  const message = entry.msg?.trim();
  if (!message) {
    return undefined;
  }

  if (entry.source === "stderr") {
    return `  stderr: ${message}`;
  }

  return `  ${message}`;
}

function renderMarkerLine(entry: EasLogEntry): string | undefined {
  if (!entry.marker) {
    return undefined;
  }

  if (entry.marker === "START_PHASE") {
    return undefined;
  }

  if (entry.marker === "END_PHASE") {
    return undefined;
  }

  return undefined;
}

function printBuildHeader(build: EasBuild, buildUrl: string | undefined, output: OutputSink): void {
  const project = build.project?.ownerAccount?.name
    ? `@${build.project.ownerAccount.name}/${build.project.slug}`
    : build.project?.slug;
  const summary = [
    project,
    build.platform ? `platform=${formatToken(build.platform)}` : undefined,
    build.buildProfile ? `profile=${build.buildProfile}` : undefined,
    build.distribution ? `distribution=${build.distribution.toLowerCase()}` : undefined,
  ].filter(Boolean);

  output.status(`Watching EAS build ${build.id}${summary.length ? ` for ${summary.join(" | ")}` : ""}.`);

  const resolvedBuildUrl = buildUrl ?? formatBuildPageUrl(build);
  if (resolvedBuildUrl) {
    output.status(`Logs: ${resolvedBuildUrl}`);
  }
}

function finishBuild(build: EasBuild, output: OutputSink): void {
  output.status(`Build ${formatToken(build.status)}.`);

  const artifactLines = [
    build.artifacts?.applicationArchiveUrl
      ? `Application archive: ${build.artifacts.applicationArchiveUrl}`
      : undefined,
    build.artifacts?.buildArtifactsUrl
      ? `Build artifacts: ${build.artifacts.buildArtifactsUrl}`
      : undefined,
    build.artifacts?.xcodeBuildLogsUrl
      ? `Xcode logs: ${build.artifacts.xcodeBuildLogsUrl}`
      : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const line of artifactLines) {
    output.status(line);
  }

  if (build.status === "ERRORED") {
    const details = [build.error?.message, build.error?.docsUrl].filter(Boolean).join(" ");
    throw new Error(details || `EAS build ${build.id} failed.`);
  }

  if (build.status === "CANCELED") {
    throw new Error(`EAS build ${build.id} was canceled.`);
  }
}

function formatBuildPageUrl(build: EasBuild): string | undefined {
  const owner = build.project?.ownerAccount?.name;
  const slug = build.project?.slug;
  if (!owner || !slug) {
    return undefined;
  }

  return `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${build.id}`;
}

function isTerminalStatus(status: string): boolean {
  return status === "FINISHED" || status === "ERRORED" || status === "CANCELED";
}

function formatPhaseLabel(phase: string): string {
  return EAS_PHASE_LABELS[phase] ?? formatToken(phase);
}

function formatBuildLabel(build: EasBuild): string {
  switch (build.platform) {
    case "IOS":
      return "iOS";
    case "ANDROID":
      return "Android";
    default:
      return formatToken(build.platform);
  }
}

function formatToken(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

export function getLogFileKey(logFileUrl: string): string {
  const url = new URL(logFileUrl);
  return url.pathname;
}

export function parseEasLogEntries(text: string): EasLogEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as EasLogEntry;
      } catch {
        return { msg: line };
      }
    });
}
