#!/usr/bin/env node

import { Command } from "commander";
import { AlreadyReportedError } from "./core/error.js";
import { registerPlatforms } from "./platforms/index.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("stare")
    .description("Stare at remote build logs.")
    .addHelpCommand(false)
    .version("0.1.5");

  registerPlatforms(program);
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof AlreadyReportedError) {
    process.exitCode = error.exitCode;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[stare] ${message}\n`);
  process.exitCode = 1;
});
