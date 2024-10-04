import { CIService } from "../services/ciService";
import { StatusBarService } from "../services/statusBarService";
import { GitService } from "../services/gitService";
import * as vscode from "vscode";

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
      const result = await ciService.getBuildStatus(tag, owner, repo, ciType);
      status = result.status;
      statusBarService.updateBuildStatus(status, tag, result.url);
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
    statusBarService.updateBuildStatus('timeout', tag, '');
  }
}