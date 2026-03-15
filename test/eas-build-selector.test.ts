import { describe, expect, it } from "vitest";
import { resolveEasBuildSelector } from "../src/platforms/eas/eas-build-selector.js";

const BUILD_ID = "11111111-2222-4333-8444-555555555555";
const BUILD_URL = `https://expo.dev/accounts/example-owner/projects/example-app/builds/${BUILD_ID}`;

describe("resolveEasBuildSelector", () => {
  it("accepts raw EAS build IDs", () => {
    expect(resolveEasBuildSelector(BUILD_ID)).toEqual({
      buildId: BUILD_ID,
    });
  });

  it("extracts the build ID from Expo build URLs", () => {
    expect(resolveEasBuildSelector(BUILD_URL)).toEqual({
      buildId: BUILD_ID,
      buildUrl: BUILD_URL,
    });
  });

  it("rejects unsupported selectors", () => {
    expect(() => resolveEasBuildSelector("example-app@preview")).toThrow(
      "Unsupported EAS build selector",
    );
  });
});
