import pc, { createColors } from "picocolors";
import type { OutputSink } from "../../core/output.js";

const RUNNER_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/u;

interface GitHubLineStyler {
  group(text: string): string;
  command(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  notice(text: string): string;
}

const colors = createColors(pc.isColorSupported);

const DEFAULT_STYLER: GitHubLineStyler = {
  group(text: string): string {
    return colors.bold(text);
  },
  command(text: string): string {
    return colors.cyan(text);
  },
  warning(text: string): string {
    return colors.yellow(text);
  },
  error(text: string): string {
    return colors.red(text);
  },
  notice(text: string): string {
    return colors.blue(text);
  },
};

export class GitHubFormattedOutput {
  private readonly groupDepthByLabel = new Map<string, number>();

  constructor(
    private readonly output: OutputSink,
    private readonly styler: GitHubLineStyler = DEFAULT_STYLER,
  ) {}

  status(message: string): void {
    this.output.status(message);
  }

  error(message: string): void {
    this.output.error(message);
  }

  writeLines(label: string, lines: readonly string[]): void {
    const formatted = this.formatLines(label, lines);
    if (formatted.length === 0) {
      return;
    }

    this.output.writeLines(label, formatted);
  }

  private formatLines(label: string, lines: readonly string[]): string[] {
    const formatted: string[] = [];
    let depth = this.groupDepthByLabel.get(label) ?? 0;

    for (const rawLine of lines) {
      const line = stripRunnerFormatting(rawLine);
      if (line.trim().length === 0) {
        continue;
      }

      if (line.startsWith("##[endgroup]")) {
        depth = Math.max(0, depth - 1);
        continue;
      }

      const groupMatch = line.match(/^##\[group\](.*)$/u);
      if (groupMatch) {
        formatted.push(`${indent(depth)}${this.styler.group(groupMatch[1].trim())}`);
        depth += 1;
        continue;
      }

      const annotationMatch = line.match(/^##\[(warning|error|notice)\](.*)$/u);
      if (annotationMatch) {
        const annotation = `${annotationMatch[1]}: ${annotationMatch[2].trim()}`;
        formatted.push(`${indent(depth)}${this.styleAnnotation(annotationMatch[1], annotation)}`);
        continue;
      }

      if (line.startsWith("[command]")) {
        formatted.push(
          `${indent(depth)}${this.styler.command(`$ ${line.slice("[command]".length).trim()}`)}`,
        );
        continue;
      }

      formatted.push(`${indent(depth)}${line}`);
    }

    this.groupDepthByLabel.set(label, depth);
    return formatted;
  }

  private styleAnnotation(level: string, text: string): string {
    switch (level) {
      case "warning":
        return this.styler.warning(text);
      case "error":
        return this.styler.error(text);
      case "notice":
        return this.styler.notice(text);
      default:
        return text;
    }
  }
}

function stripRunnerFormatting(line: string): string {
  return line.replace(RUNNER_TIMESTAMP_PATTERN, "").trimEnd();
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}
