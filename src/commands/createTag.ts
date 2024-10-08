import * as vscode from "vscode";
import * as semver from "semver";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { showError } from "../utils/errorHandler";
import { updateStatusBar } from "../utils/statusBarUpdater";
import { CIService } from "../services/ciService";
import { checkBuildStatus } from "../utils/ciUtils";
import { pollBuildStatusImmediate } from "./pushAndCheckBuild";

export async function createTag(
  type: "major" | "minor" | "patch",
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string,
  ciService: CIService
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
      const newVersion = semver.inc(version, type);
      if (newVersion) {
        const newTag = `${prefix || ""}${newVersion}${suffix || ""}`;
        await gitService.createTagInternal(newTag);
        
        // Add a small delay to ensure the tag is created locally
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        try {
          await gitService.pushTag(newTag);
        } catch (pushError) {
          console.error(`Error pushing tag ${newTag}:`, pushError);
          vscode.window.showErrorMessage(`Failed to push tag ${newTag}. Please try again or push manually.`);
          return;
        }
        
        const { owner, repo } = await gitService.getOwnerAndRepo();
        if (!owner || !repo) {
          throw new Error('Unable to determine owner and repo');
        }
        
        vscode.window.showInformationMessage(
          `New tag ${newTag} created and pushed for ${owner}/${repo}`
        );
        
        // Update status bar immediately with the new tag
        await updateStatusBar(gitService, statusBarService, defaultBranch, ciService);
        
        // Start checking build status
        checkBuildStatus(newTag, owner, repo, ciService, statusBarService, gitService);

        const ciType = gitService.detectCIType();
        if (!ciType) {
          throw new Error('Unable to detect CI type');
        }

        // Start polling for tag build status
        await pollBuildStatusImmediate(newTag, owner, repo, ciType, ciService, statusBarService, true);
      }
    }
  } catch (error) {
    showError(error, "Error creating and pushing tag");
  }
}
