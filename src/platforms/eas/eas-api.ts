import { readFile } from "node:fs/promises";
import { expandHomeDirectory } from "../../utils/path.js";

const DEFAULT_EXPO_STATE_PATH = "~/.expo/state.json";
const EXPO_GRAPHQL_ENDPOINT = "https://api.expo.dev/graphql";
const BUILD_QUERY = `
  query StareBuildById($buildId: ID!) {
    builds {
      byId(buildId: $buildId) {
        id
        status
        platform
        error {
          message
          docsUrl
        }
        artifacts {
          buildUrl
          xcodeBuildLogsUrl
          applicationArchiveUrl
          buildArtifactsUrl
        }
        logFiles
        project {
          id
          name
          slug
          ... on App {
            ownerAccount {
              id
              name
            }
          }
        }
        channel
        distribution
        buildProfile
        createdAt
        updatedAt
        completedAt
      }
    }
  }
`;

export interface EasBuild {
  id: string;
  status: string;
  platform: string;
  error: {
    message: string;
    docsUrl?: string | null;
  } | null;
  artifacts: {
    buildUrl?: string | null;
    xcodeBuildLogsUrl?: string | null;
    applicationArchiveUrl?: string | null;
    buildArtifactsUrl?: string | null;
  } | null;
  logFiles: string[];
  project: {
    id: string;
    name: string;
    slug: string;
    ownerAccount?: {
      id: string;
      name: string;
    } | null;
  } | null;
  channel?: string | null;
  distribution?: string | null;
  buildProfile?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

interface ExpoStateFile {
  auth?: {
    sessionSecret?: string;
  };
}

interface GraphQLErrorResponse {
  errors?: Array<{ message?: string }>;
  data?: {
    builds?: {
      byId?: EasBuild | null;
    };
  };
}

export interface EasBuildApi {
  getBuild(buildId: string): Promise<EasBuild>;
  getLogFile(logFileUrl: string): Promise<string>;
}

export class ExpoApiClient implements EasBuildApi {
  constructor(
    private readonly headers: Headers,
  ) {}

  static async fromEnvironment(): Promise<ExpoApiClient> {
    return new ExpoApiClient(await resolveExpoApiHeaders());
  }

  async getBuild(buildId: string): Promise<EasBuild> {
    const response = await fetch(EXPO_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        query: BUILD_QUERY,
        variables: { buildId },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Expo API request failed (${response.status} ${response.statusText}): ${body}`,
      );
    }

    const payload = (await response.json()) as GraphQLErrorResponse;
    if (payload.errors?.length) {
      const message =
        payload.errors.find((error) => error.message)?.message ?? "Unknown Expo API error.";
      throw new Error(`Expo API request failed: ${message}`);
    }

    const build = payload.data?.builds?.byId;
    if (!build) {
      throw new Error(`EAS build ${buildId} was not found.`);
    }

    return build;
  }

  async getLogFile(logFileUrl: string): Promise<string> {
    const response = await fetch(logFileUrl);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to fetch EAS log file (${response.status} ${response.statusText}): ${body}`,
      );
    }

    return response.text();
  }
}

export async function resolveExpoApiHeaders(): Promise<Headers> {
  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "stare-cli",
  });

  const sessionSecret = await readExpoSessionSecret();
  if (!sessionSecret) {
    throw new Error(
      `Expo authentication was not found in ${DEFAULT_EXPO_STATE_PATH}. stare reads Expo login state from the EAS CLI session file. Install EAS CLI if needed, run \`eas login\`, then retry.`,
    );
  }

  headers.set("expo-session", sessionSecret);
  return headers;
}

async function readExpoSessionSecret(): Promise<string | null> {
  try {
    const content = await readFile(expandHomeDirectory(DEFAULT_EXPO_STATE_PATH), "utf8");
    const parsed = JSON.parse(content) as ExpoStateFile;
    return parsed.auth?.sessionSecret ?? null;
  } catch {
    return null;
  }
}
