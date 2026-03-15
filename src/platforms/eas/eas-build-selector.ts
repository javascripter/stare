const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EasBuildSelector {
  buildId: string;
  buildUrl?: string;
}

export function resolveEasBuildSelector(input: string): EasBuildSelector {
  if (BUILD_ID_PATTERN.test(input)) {
    return { buildId: input };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error(
      `Unsupported EAS build selector: ${input}. Use a build ID or Expo build URL.`,
    );
  }

  if (!isExpoBuildUrl(parsedUrl)) {
    throw new Error(
      `Unsupported EAS build selector: ${input}. Use a build ID or Expo build URL.`,
    );
  }

  const buildId = parsedUrl.pathname.split("/").pop();
  if (!buildId || !BUILD_ID_PATTERN.test(buildId)) {
    throw new Error(`Could not find a valid EAS build ID in ${input}.`);
  }

  return {
    buildId,
    buildUrl: input,
  };
}

function isExpoBuildUrl(url: URL): boolean {
  return (
    (url.hostname === "expo.dev" || url.hostname.endsWith(".expo.dev")) &&
    /\/accounts\/[^/]+\/projects\/[^/]+\/builds\/[^/]+\/?$/.test(url.pathname)
  );
}
