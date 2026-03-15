import pc from "picocolors";

export interface OutputSink {
  status(message: string): void;
  error(message: string): void;
  writeLines(label: string, lines: readonly string[]): void;
}

const COLORS = [
  pc.cyan,
  pc.green,
  pc.yellow,
  pc.magenta,
  pc.blue,
  pc.red,
] as const;

export class TerminalOutput implements OutputSink {
  private readonly colorByLabel = new Map<string, (text: string) => string>();

  status(message: string): void {
    process.stderr.write(`${pc.dim("[stare]")} ${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${pc.red("[stare]")} ${message}\n`);
  }

  writeLines(label: string, lines: readonly string[]): void {
    if (lines.length === 0) {
      return;
    }

    const color = this.colorForLabel(label);
    const prefix = `${color(`[${label}]`)}`;

    for (const line of lines) {
      for (const segment of line.split(/\r?\n/)) {
        process.stdout.write(`${prefix} ${segment}\n`);
      }
    }
  }

  private colorForLabel(label: string): (text: string) => string {
    const existing = this.colorByLabel.get(label);
    if (existing) {
      return existing;
    }

    const color = COLORS[this.colorByLabel.size % COLORS.length];
    this.colorByLabel.set(label, color);
    return color;
  }
}
