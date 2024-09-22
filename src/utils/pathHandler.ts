import * as fs from "fs";
import * as path from "path";

export function isGitDirectory(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch (error) {
    return false;
  }
}
