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
    statusBarService.updateBranchBuildStatus('pending', currentBranch, '', repo);
    vscode.window.showInformationMessage(`Checking build status for ${owner}/${repo} branch ${currentBranch}...`);

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
  const finalStatuses = ['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out'];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { status, url, message } = await ciService.getImmediateBuildStatus(ref, owner, repo, ciType, isTag);
      console.log(`Build status for ${owner}/${repo} ${isTag ? 'tag' : 'branch'} ${ref}: ${status}`);
      
      if (isTag) {
        statusBarService.updateBuildStatus(status, ref, url, repo);
      } else {
        statusBarService.updateBranchBuildStatus(status, ref, url, repo);
      }

      if (finalStatuses.includes(status)) {
        vscode.window.showInformationMessage(`${owner}/${repo} ${isTag ? `tag ${ref}` : `branch ${ref}`}: Build status ${status}`);
        return;
      }

      if (status === 'no_runs' && attempt === 0) {
        vscode.window.showInformationMessage(`${owner}/${repo} ${isTag ? `tag ${ref}` : `branch ${ref}`}: Waiting for CI to start...`);
      }

      const interval = inProgressStatuses.includes(status) || status === 'no_runs'
        ? Math.min(initialInterval * Math.pow(1.5, attempt), maxInterval)
        : maxInterval;
      
      await new Promise(resolve => setTimeout(resolve, interval));
    } catch (error) {
      console.error(`Error polling ${owner}/${repo} ${isTag ? 'tag' : 'branch'} ${ref} build status:`, error);
      vscode.window.showErrorMessage(`Error checking ${owner}/${repo} ${isTag ? 'tag' : 'branch'} ${ref} build status. Please check your CI configuration.`);
      return;
    }
  }

  vscode.window.showInformationMessage(`${owner}/${repo} ${isTag ? `tag ${ref}` : `branch ${ref}`}: Build status check timed out. Check CI dashboard.`);
}

