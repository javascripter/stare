import { homedir } from "node:os";
import { join } from "node:path";

export function expandHomeDirectory(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

