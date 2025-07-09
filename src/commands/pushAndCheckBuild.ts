import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { CIService } from "../services/ciService";
import { handleError } from "../utils/errorHandler";
import { Logger } from '../utils/logger';

// TODO: This entire file needs to be refactored for multi-repo support.
// The functions currently assume a single, global gitService and ciService.
// This logic should be triggered from a specific repository context.

export async function pushAndCheckBuild(
  gitService: GitService,
  statusBarService: StatusBarService
) {
  try {
    const currentBranch = await gitService.getCurrentBranch();
    if (!currentBranch) {
      vscode.window.showInformationMessage("Not on a branch, skipping push and build check.");
      return;
    }

    const ownerAndRepo = await gitService.getOwnerAndRepo();
    if (!ownerAndRepo) {
      vscode.window.showErrorMessage("Could not determine repository owner and name.");
      return;
    }
    
    const { owner, repo } = ownerAndRepo;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Pushing branch ${currentBranch} and checking build status...`,
      cancellable: false
    }, async (progress) => {
      progress.report({ message: "Pushing to remote..." });
      await gitService.pushChanges(currentBranch);
      
      progress.report({ message: "Triggering UI and build status refresh..." });
      const multiRepoService = statusBarService.getMultiRepoService();
      const repoRoot = gitService.getRepoRoot();
      multiRepoService.invalidateCacheForRepo(repoRoot);

      // A short delay to allow the CI to pick up the new commit
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Finally, trigger a full refresh of the status bar
      await statusBarService.reloadEverything(true);
    });
  } catch (error) {
    handleError(error, "Error pushing and checking build");
  }
}
