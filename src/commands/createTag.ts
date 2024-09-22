import * as vscode from "vscode";
import * as semver from "semver";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { showError } from "../utils/errorHandler";
import { updateStatusBar } from "../utils/statusBarUpdater";

export async function createTag(
  versionPart: "major" | "minor" | "patch",
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string
) {
  try {
    const tags = await gitService.fetchAndTags();
    if (tags) {
      const latestTag = tags.latest || "0.0.0";
      const tagMatch = latestTag.match(/^([^\d]*)(\d+\.\d+\.\d+)(.*)$/);
      if (!tagMatch) {
        throw new Error("Invalid tag format.");
      }
      const [, prefix, version, suffix] = tagMatch;
      const newVersion = semver.inc(version, versionPart);
      if (newVersion) {
        await gitService.createTagInternal(
          `${prefix || ""}${newVersion}${suffix || ""}`
        );
        gitService.clearCachedTags();
        vscode.window.showInformationMessage(
          `Created and pushed new tag: ${prefix || ""}${newVersion}${
            suffix || ""
          }`
        );
        await updateStatusBar(gitService, statusBarService, defaultBranch);
      }
    }
  } catch (error) {
    showError(error, "Error creating tag");
  }
}
