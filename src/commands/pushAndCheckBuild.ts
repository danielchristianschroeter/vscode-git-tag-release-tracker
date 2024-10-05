import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { CIService } from "../services/ciService";
import { showError } from "../utils/errorHandler";
import { updateStatusBar } from "../utils/statusBarUpdater";

export async function pushAndCheckBuild(
  gitService: GitService,
  statusBarService: StatusBarService,
  ciService: CIService
) {
  try {
    const currentBranch = gitService.getCurrentBranch();
    await gitService.pushChanges(currentBranch);
    vscode.window.showInformationMessage(`Pushed changes to ${currentBranch}`);

    const { owner, repo } = await gitService.getOwnerAndRepo();
    if (!owner || !repo) {
      throw new Error('Unable to determine owner and repo');
    }

    const ciType = gitService.detectCIType();
    if (!ciType) {
      throw new Error('Unable to detect CI type');
    }

    // Clear the cache for this branch
    ciService.clearCacheForBranch(currentBranch, owner, repo, ciType);

    // Immediately set status to pending
    statusBarService.updateBranchBuildStatus('pending', currentBranch, '');
    vscode.window.showInformationMessage(`Checking build status...`);

    // Start immediate polling for branch
    await pollBuildStatusImmediate(currentBranch, owner, repo, ciType, ciService, statusBarService, false);

    // Also update the latest tag status
    const latestTag = await gitService.fetchAndTags().then(tags => tags?.latest);
    if (latestTag) {
      await pollBuildStatusImmediate(latestTag, owner, repo, ciType, ciService, statusBarService, true);
    }

  } catch (error) {
    showError(error, "Error pushing changes and checking build status");
  }
}

export async function pollBuildStatusImmediate(
  ref: string,
  owner: string,
  repo: string,
  ciType: 'github' | 'gitlab',
  ciService: CIService,
  statusBarService: StatusBarService,
  isTag: boolean
) {
  const maxAttempts = 30;
  const initialInterval = 2000; // 2 seconds
  const maxInterval = 10000; // 10 seconds

  const inProgressStatuses = ['in_progress', 'queued', 'requested', 'waiting', 'pending'];
  const finalStatuses = ['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'no_workflow'];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { status, url, message } = await ciService.getImmediateBuildStatus(ref, owner, repo, ciType, isTag);
      console.log(`Build status for ${isTag ? 'tag' : 'branch'} ${ref}: ${status}`);
      
      if (isTag) {
        statusBarService.updateBuildStatus(status, ref, url);
      } else {
        statusBarService.updateBranchBuildStatus(status, ref, url);
      }

      if (finalStatuses.includes(status)) {
        console.log(`Final build status for ${isTag ? 'tag' : 'branch'} ${ref}: ${status}`);
        if (status === 'no_workflow') {
          vscode.window.showInformationMessage(`No workflow found for ${isTag ? 'tag' : 'branch'} ${ref}. Please check your CI configuration.`);
        } else {
          vscode.window.showInformationMessage(`${isTag ? 'Tag' : 'Branch'} build status: ${status}`);
        }
        return;
      }

      // For in-progress statuses, we'll continue polling
      const interval = inProgressStatuses.includes(status)
        ? Math.min(initialInterval * Math.pow(1.5, attempt), maxInterval)
        : maxInterval; // For unknown statuses, we'll use the max interval
      
      await new Promise(resolve => setTimeout(resolve, interval));
    } catch (error) {
      console.error(`Error polling ${isTag ? 'tag' : 'branch'} build status:`, error);
      vscode.window.showErrorMessage(`Error checking ${isTag ? 'tag' : 'branch'} build status. Please check your CI configuration.`);
      return;
    }
  }

  vscode.window.showInformationMessage(`${isTag ? 'Tag' : 'Branch'} build status check timed out. Please check your CI dashboard for updates.`);
}
