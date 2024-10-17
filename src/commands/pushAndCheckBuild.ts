import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { CIService } from "../services/ciService";
import { handleError } from "../utils/errorHandler";
import { Logger } from '../utils/logger';

export async function pushAndCheckBuild(
  gitService: GitService,
  statusBarService: StatusBarService,
  ciService: CIService
) {
  try {
    const currentBranch = await gitService.getCurrentBranch();
    if (!currentBranch) {
      throw new Error('Unable to determine current branch');
    }

    await gitService.pushChanges(currentBranch);
    vscode.window.showInformationMessage(`Pushed changes to ${currentBranch}`);

    const ownerAndRepo = await gitService.getOwnerAndRepo();
    if (!ownerAndRepo) {
      throw new Error('Unable to determine owner and repo');
    }
    const { owner, repo } = ownerAndRepo;

    const ciType = gitService.detectCIType();
    if (!ciType) {
      throw new Error('Unable to detect CI type');
    }

    // Clear the cache for this branch
    ciService.clearCacheForBranch(currentBranch, owner, repo, ciType);

    // Immediately set status to pending
    await statusBarService.updateCIStatus('pending', currentBranch, '', false);
    vscode.window.showInformationMessage(`Checking build status for ${owner}/${repo} branch ${currentBranch}...`);

    // Add a delay before starting to poll
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds delay

    // Start immediate polling for branch
    await pollBuildStatusImmediate(currentBranch, owner, repo, ciType, ciService, statusBarService, false);

    // Also update the latest tag status
    const latestTag = await gitService.fetchAndTags();
    if (latestTag.latest) {
      await pollBuildStatusImmediate(latestTag.latest, owner, repo, ciType, ciService, statusBarService, true);
    }

    // After successful push and build status check
    await statusBarService.updateEverything(true);

  } catch (error) {
    handleError(error, "Error pushing changes and checking build");
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
      Logger.log(`Build status for ${owner}/${repo} ${isTag ? 'tag' : 'branch'} ${ref}: ${status}`, 'INFO');
      
      await statusBarService.updateCIStatus(status, ref, url, isTag);

      if (finalStatuses.includes(status)) {
        vscode.window.showInformationMessage(`Build status ${status} for ${isTag ? 'tag' : 'branch'} ${ref} (${owner}/${repo})`);
        return;
      }

      if (status === 'no_runs' && attempt === 0) {
        vscode.window.showInformationMessage(`Waiting for ${ciType} to start build for ${isTag ? 'tag' : 'branch'} ${ref} (${owner}/${repo})`);
      }

      const interval = inProgressStatuses.includes(status) || status === 'no_runs'
        ? Math.min(initialInterval * Math.pow(1.5, attempt), maxInterval)
        : maxInterval;
      
      await new Promise(resolve => setTimeout(resolve, interval));
    } catch (error) {
      Logger.log(`Error polling ${owner}/${repo} ${isTag ? 'tag' : 'branch'} ${ref} build status: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      vscode.window.showErrorMessage(`Error checking ${isTag ? 'tag' : 'branch'} ${ref} build status. Please check your CI configuration. (${owner}/${repo})`);
      return;
    }
  }

  vscode.window.showInformationMessage(`Build status check timed out for ${isTag ? 'tag' : 'branch'} ${ref}. Check CI dashboard. (${owner}/${repo})`);
}
