import { CIService } from "../services/ciService";
import { StatusBarService } from "../services/statusBarService";
import { GitService } from "../services/gitService";
import * as vscode from "vscode";

// Add this function at the top of the file
function isTemporaryStatus(status: string): boolean {
  const temporaryStatuses = ['pending', 'in_progress', 'queued', 'running'];
  return temporaryStatuses.includes(status);
}

export async function checkBuildStatus(
  tag: string,
  owner: string,
  repo: string,
  ciService: CIService,
  statusBarService: StatusBarService,
  gitService: GitService
) {
  const ciType = gitService.detectCIType();
  if (!ciType) {
    console.log('No CI configuration detected, skipping build status check');
    return;
  }

  let status = 'pending';
  let attempts = 0;
  const maxAttempts = 30; // Check for 5 minutes (30 * 10 seconds)

  while ((status === 'pending' || status === 'in_progress' || status === 'queued') && attempts < maxAttempts) {
    try {
      const result = await ciService.getBuildStatus(tag, owner, repo, ciType, true);
      status = result.status;
      statusBarService.updateBuildStatus(status, tag, result.url, repo);
      vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', result.url);
    } catch (error) {
      console.error('Error checking build status:', error);
      status = 'error';
    }
    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
    attempts++;
  }

  if (attempts >= maxAttempts) {
    console.log(`Build status check timed out for tag ${tag}`);
    statusBarService.updateBuildStatus('timeout', tag, '', repo);
  }
}

export async function checkBranchBuildStatus(
  branch: string,
  owner: string,
  repo: string,
  ciService: CIService,
  statusBarService: StatusBarService,
  gitService: GitService
) {
  const ciType = gitService.detectCIType();
  if (!ciType) {
    console.log('No CI type detected');
    return;
  }

  let status = 'pending';
  let url = '';
  const maxAttempts = 30; // 5 minutes total
  let attempts = 0;

  const checkStatus = async () => {
    const result = await ciService.getBuildStatus(branch, owner, repo, ciType, false);
    status = result.status;
    url = result.url;

    statusBarService.updateBranchBuildStatus(status, branch, url, repo);

    if (['in_progress', 'queued', 'requested', 'waiting', 'pending'].includes(status)) {
      setTimeout(checkStatus, 10000); // Check again in 10 seconds for in-progress states
    } else if (attempts < maxAttempts) {
      setTimeout(checkStatus, 30000); // Check again in 30 seconds for other states
    }

    attempts++;
  };

  // Initial check after a short delay
  setTimeout(checkStatus, 3000);
}