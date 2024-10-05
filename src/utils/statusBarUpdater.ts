import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { showError } from "./errorHandler";
import * as semver from "semver";
import { CIService } from "../services/ciService";
import { debounce } from "./debounce";

export const logError = (message: string, error: any) => {
  console.error(message, error);
};

interface BuildStatusCache {
  [key: string]: { status: string; url: string; tag: string };
}

const buildStatusCache: BuildStatusCache = {};

const temporaryGitHubStatuses = ['action_required', 'in_progress', 'queued', 'requested', 'waiting', 'pending'];
const temporaryGitLabStatuses = ['waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'];

function isTemporaryStatus(status: string): boolean {
  return temporaryGitHubStatuses.includes(status) || temporaryGitLabStatuses.includes(status) || status === 'unknown';
}

export function getConfiguration() {
  return vscode.workspace.getConfiguration('gitTagReleaseTracker');
}

export async function updateStatusBar(
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string,
  ciService: CIService
) {
  if (!gitService) {
    return;
  }

  try {
    console.log("Initializing Git...");
    const repoChanged = await gitService.initializeGit();

    if (repoChanged) {
      statusBarService.clearStatusBar();
      ciService.clearCache();
    }

    const currentRepo = gitService.getCurrentRepo();
    if (!currentRepo) {
      console.log("No Git repository detected.");
      statusBarService.clearStatusBar();
      return;
    }

    console.log("Fetching tags...");
    const tagsResult = await gitService.fetchAndTags();
    const branchDetected = await gitService.detectBranch();

    if (!branchDetected) {
      console.log("No branch detected.");
      statusBarService.clearStatusBar();
      return;
    }

    await gitService.getRemotes();
    const currentBranch = gitService.getCurrentBranch();

    let statusBarText = '';
    let tooltip = '';
    let command: string | undefined;

    const ciType = gitService.detectCIType();
    const latestTag = tagsResult?.latest || '';

    const config = getConfiguration();
    const ciProviders = config.get<{ [key: string]: { token: string, apiUrl: string } }>('ciProviders', {});

    const anyCIConfigured = Object.values(ciProviders).some(provider => !!provider.token && !!provider.apiUrl);

    if (ciType && anyCIConfigured) {
      const currentProvider = ciProviders[ciType];
      if (currentProvider && currentProvider.token && currentProvider.apiUrl) {
        await updateBuildStatus(gitService, statusBarService, ciService, latestTag, ciType);
        await updateBranchBuildStatus(gitService, statusBarService, ciService, currentBranch, ciType);
      } else {
        console.log(`CI type ${ciType} detected but not configured.`);
        statusBarService.updateBuildStatus('unknown', latestTag, '');
        statusBarService.updateBranchBuildStatus('unknown', currentBranch, '');
      }
    } else {
      console.log('No CI configured or CI type not detected.');
      statusBarService.hideBuildStatus();
      statusBarService.hideBranchBuildStatus();
    }

    if (!tagsResult || !latestTag) {
      console.log("No latest tag found, counting all commits as unreleased");
      const commits = await gitService.getCommits(defaultBranch, currentBranch);
      if (commits) {
        statusBarText = `${currentRepo}/${currentBranch} | ${commits.total} unreleased commits | No version available`;
        tooltip = `${commits.total} unreleased commits for ${currentRepo}/${currentBranch}`;
        command = "extension.openCompareLink";
        
        // Show only the initial version button
        statusBarService.hideButtons();
        statusBarService.updateButton(
          0,
          "1.0.0",
          "Create initial version tag 1.0.0"
        );
        statusBarService.showButtons();
      } else {
        console.log("No commits found for the entire branch");
        statusBarService.hideButtons();
      }
    } else {
      const tagMatch = latestTag.match(
        /^([^\d]*)(\d+)\.(\d+)\.(\d+)(.*)$/
      );
      if (!tagMatch) {
        statusBarText = `${currentRepo}/${currentBranch} | No version tag with semantic versioning found`;
        tooltip = "No version tag with semantic versioning found";
        statusBarService.hideButtons();
      } else {
        const [, prefix, major, minor, patch, suffix] = tagMatch;
        const unreleasedCommits = await gitService.getUnreleasedCommits(latestTag, currentBranch);

        statusBarText = `${currentRepo}/${currentBranch} | ${unreleasedCommits} unreleased commits`;
        tooltip = `${unreleasedCommits} unreleased commits for ${currentRepo}/${currentBranch} | Latest version: ${latestTag}`;

        if (currentBranch === defaultBranch && unreleasedCommits > 0) {
          command = "extension.openCompareLink";
          updateVersionButtons(statusBarService, major, minor, patch, prefix, suffix);
        } else {
          statusBarService.hideButtons();
        }
      }
    }

    statusBarService.updateStatusBar(statusBarText, tooltip, command);
  } catch (error) {
    logError("Error updating status bar:", error);
    statusBarService.clearStatusBar();
    if (error instanceof Error) {
      showError(error, "Error fetching git data");
    } else {
      showError(new Error(String(error)), "Error fetching git data");
    }
  }
}

function updateVersionButtons(statusBarService: StatusBarService, major: string, minor: string, patch: string, prefix: string, suffix: string) {
  ['major', 'minor', 'patch'].forEach((versionType, index) => {
    const newVersion = semver.inc(`${major}.${minor}.${patch}`, versionType as semver.ReleaseType);
    statusBarService.updateButton(
      index,
      `${newVersion}`,
      `Create and push ${versionType} tag version ${prefix}${newVersion}${suffix}`
    );
  });
  statusBarService.showButtons();
}

async function updateBuildStatus(
  gitService: GitService, 
  statusBarService: StatusBarService, 
  ciService: CIService, 
  latestTag: string, 
  ciType: 'github' | 'gitlab'
) {
  try {
    const { owner, repo } = await gitService.getOwnerAndRepo();
    if (!owner || !repo) {
      throw new Error('Unable to determine owner and repo');
    }

    const { status, url, message } = await ciService.getBuildStatus(latestTag, owner, repo, ciType, true);
    console.log(`Build status received in updateStatusBar: ${status}`);

    statusBarService.updateBuildStatus(status, latestTag, url);
    vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', url);

    if (message && status === 'error') {
      vscode.window.showErrorMessage(message);
    }
  } catch (error) {
    console.error('Error updating build status:', error);
    statusBarService.updateBuildStatus('error', latestTag, '');
    const { owner, repo } = await gitService.getOwnerAndRepo();
    const defaultUrl = ciType === 'github' 
      ? `https://github.com/${owner}/${repo}/actions`
      : `https://gitlab.com/${owner}/${repo}/-/pipelines`;
    vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', defaultUrl);
    vscode.window.showErrorMessage('Error fetching build status. Please check your CI configuration and token.');
  }
}

async function updateBranchBuildStatus(
  gitService: GitService,
  statusBarService: StatusBarService,
  ciService: CIService,
  currentBranch: string,
  ciType: 'github' | 'gitlab'
) {
  try {
    const { owner, repo } = await gitService.getOwnerAndRepo();
    if (!owner || !repo) {
      throw new Error('Unable to determine owner and repo');
    }

    const { status, url, message } = await ciService.getBuildStatus(currentBranch, owner, repo, ciType, false);
    console.log(`Branch build status received in updateStatusBar: ${status}`);

    statusBarService.updateBranchBuildStatus(status, currentBranch, url);
    vscode.commands.executeCommand('gitTagReleaseTracker._branchBuildStatusUrl', url);

    if (message && status === 'error') {
      vscode.window.showErrorMessage(message);
    }
  } catch (error) {
    console.error('Error updating branch build status:', error);
    statusBarService.updateBranchBuildStatus('error', currentBranch, '');
    const { owner, repo } = await gitService.getOwnerAndRepo();
    const defaultUrl = ciType === 'github'
      ? `https://github.com/${owner}/${repo}/actions`
      : `https://gitlab.com/${owner}/${repo}/-/pipelines`;
    vscode.commands.executeCommand('gitTagReleaseTracker._branchBuildStatusUrl', defaultUrl);
    vscode.window.showErrorMessage('Error fetching branch build status. Please check your CI configuration and token.');
  }
}

export function createStatusBarUpdater(
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string,
  ciService: CIService
) {
  const updateStatusBarCallback = async () => {
    console.log("Updating status bar...");
    try {
      await updateStatusBar(gitService, statusBarService, defaultBranch, ciService);
    } catch (error) {
      console.log("Error updating status bar:", error);
    }
  };

  const debouncedUpdateStatusBar = debounce(updateStatusBarCallback, 300);

  return {
    updateNow: updateStatusBarCallback,
    debouncedUpdate: debouncedUpdateStatusBar
  };
}