import type { Command } from "commander";
import type { WatchPlatform } from "../core/platform.js";
import { easPlatform } from "./eas/eas-platform.js";
import { githubPlatform } from "./github/github-platform.js";

const PLATFORMS: readonly WatchPlatform[] = [githubPlatform, easPlatform];

export function registerPlatforms(program: Command): void {
  for (const platform of PLATFORMS) {
    platform.register(program);
  }
}
