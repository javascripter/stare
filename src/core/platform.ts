import type { Command } from "commander";

export interface WatchPlatform {
  readonly name: string;
  readonly description: string;
  register(program: Command): void;
}

