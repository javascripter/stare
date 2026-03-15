import type { Command } from "commander";
import type { WatchPlatform } from "../../core/platform.js";
import { watchEasBuild } from "./eas-build-watcher.js";

interface EasBuildViewOptions {
  pollIntervalMs: number;
}

export const easPlatform: WatchPlatform = {
  name: "eas",
  description: "Expo EAS Build tools.",
  register(program: Command) {
    const eas = program
      .command("eas")
      .description("Expo EAS Build tools.")
      .action(() => {
        eas.help();
      });

    const build = eas
      .command("build")
      .description("View and follow Expo EAS builds.")
      .action(() => {
        build.help();
      });

    build
      .command("view")
      .description("View and follow Expo EAS build logs.")
      .argument("<build-id-or-url>", "EAS build ID or Expo build URL")
      .option(
        "--poll-interval-ms <ms>",
        "Build polling interval in milliseconds",
        parseNumberOption,
        5_000,
      )
      .addHelpText(
        "after",
        `
Examples:
  $ stare eas build view 11111111-2222-4333-8444-555555555555
  $ stare eas build view https://expo.dev/accounts/example-owner/projects/example-app/builds/11111111-2222-4333-8444-555555555555
`,
      )
      .action(async (buildSelector: string, options: EasBuildViewOptions) => {
        await watchEasBuild(buildSelector, options);
      });
  },
};

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric option: ${value}`);
  }

  return parsed;
}
