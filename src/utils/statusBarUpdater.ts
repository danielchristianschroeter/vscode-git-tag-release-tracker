import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { showError } from "./errorHandler";
import * as semver from "semver";
import { CIService } from "../services/ciService";

interface BuildStatusCache {
  [key: string]: { status: string; url: string; tag: string };
}

const buildStatusCache: BuildStatusCache = {};

const temporaryGitHubStatuses = ['action_required', 'in_progress', 'queued', 'requested', 'waiting', 'pending'];
const temporaryGitLabStatuses = ['waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'];

function isTemporaryStatus(status: string): boolean {
  return temporaryGitHubStatuses.includes(status) || temporaryGitLabStatuses.includes(status) || status === 'unknown';
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
      // Clear the status bar when switching repositories
      statusBarService.clearStatusBar();
    }

    if (!gitService.getCurrentRepo()) {
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
    const currentRepo = gitService.getCurrentRepo();

    if (!tagsResult || !tagsResult.latest) {
      // No latest tag found, count all commits from default branch initially
      console.log("No latest tag found, counting all commits as unreleased");
      const commits = await gitService.getCommits(defaultBranch, currentBranch);
      if (commits) {
        const statusBarText = `${currentRepo}/${currentBranch} | ${commits.total} unreleased commits | No version available`;
        const tooltip = `${commits.total} unreleased commits for ${currentRepo}/${currentBranch}`;
        statusBarService.updateStatusBar(
          statusBarText,
          tooltip,
          "extension.openCompareLink"
        );
        statusBarService.updateButton(
          0,
          "1.0.0",
          "Create initial version tag 1.0.0"
        );
        statusBarService.showButtons();
      } else {
        console.log("No commits found for the entire branch");
      }
      statusBarService.updateBuildStatus('unknown', 'N/A', '');
      return;
    }

    const tagMatch = tagsResult.latest.match(
      /^([^\d]*)(\d+)\.(\d+)\.(\d+)(.*)$/
    );
    if (!tagMatch) {
      // No semantic versioning tag found
      const statusBarText = `${currentRepo}/${currentBranch} | No version tag with semantic versioning found`;
      const tooltip = "No version tag with semantic versioning found";
      statusBarService.updateStatusBar(statusBarText, tooltip);
      statusBarService.hideButtons();
      statusBarService.updateBuildStatus('unknown', 'N/A', '');
      return;
    }

    const [, prefix, major, minor, patch, suffix] = tagMatch;
    const latestTag = tagsResult.latest;
    const unreleasedCommits = await gitService.getUnreleasedCommits(latestTag, currentBranch);

    const latestVersion = `${prefix}${major}.${minor}.${patch}${suffix}`;
    const statusBarText = `${currentRepo}/${currentBranch} | ${unreleasedCommits} unreleased commits | ${latestVersion}`;
    const tooltip = `${unreleasedCommits} unreleased commits for ${currentRepo}/${currentBranch} | Latest version: ${latestVersion}`;

    statusBarService.updateStatusBar(statusBarText, tooltip);

    if (currentBranch === defaultBranch && unreleasedCommits > 0) {
      statusBarService.updateStatusBar(
        statusBarText,
        tooltip,
        "extension.openCompareLink"
      );

      // Update version buttons
      statusBarService.updateButton(
        0,
        `${semver.inc(`${major}.${minor}.${patch}`, "major")}`,
        `Create and push major tag version ${prefix}${semver.inc(
          `${major}.${minor}.${patch}`,
          "major"
        )}${suffix}`
      );
      statusBarService.updateButton(
        1,
        `${semver.inc(`${major}.${minor}.${patch}`, "minor")}`,
        `Create and push minor tag version ${prefix}${semver.inc(
          `${major}.${minor}.${patch}`,
          "minor"
        )}${suffix}`
      );
      statusBarService.updateButton(
        2,
        `${semver.inc(`${major}.${minor}.${patch}`, "patch")}`,
        `Create and push patch tag version ${prefix}${semver.inc(
          `${major}.${minor}.${patch}`,
          "patch"
        )}${suffix}`
      );
      statusBarService.showButtons();
    } else {
      statusBarService.hideButtons();
    }

    // Check if CI configuration exists
    const ciType = await gitService.hasCIConfiguration();
    
    // Check build status only if CI configuration exists
    if (ciType) {
      const cachedStatus = buildStatusCache[currentRepo];
      if (repoChanged || !cachedStatus || cachedStatus.tag !== latestTag || isTemporaryStatus(cachedStatus.status)) {
        try {
          console.log('Fetching owner and repo...');
          const { owner, repo } = await gitService.getOwnerAndRepo();
          console.log('Owner and repo:', { owner, repo });

          if (!owner || !repo) {
            throw new Error('Unable to determine owner and repo');
          }

          console.log('Fetching build status...');
          const { status, url, message } = await ciService.getBuildStatus(latestTag, owner, repo, ciType);
          console.log(`Build status received in updateStatusBar: ${status}`);

          if (message && status === 'error') {
            vscode.window.showErrorMessage(message);
          }

          if (!isTemporaryStatus(status)) {
            buildStatusCache[currentRepo] = { status, url, tag: latestTag };
          }
          statusBarService.updateBuildStatus(status, latestTag, url);
          vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', url);
        } catch (error) {
          console.error('Error updating build status:', error);
          statusBarService.updateBuildStatus('error', latestTag, '');
          // Set a default URL even in case of an error
          const { owner, repo } = await gitService.getOwnerAndRepo();
          const defaultUrl = ciType === 'github' 
            ? `https://github.com/${owner}/${repo}/actions`
            : `https://gitlab.com/${owner}/${repo}/-/pipelines`;
          vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', defaultUrl);
          vscode.window.showErrorMessage('Error fetching build status. Please check your CI configuration and token.');
        }
      } else {
        console.log('Using cached build status');
        const { status, url, tag } = cachedStatus;
        statusBarService.updateBuildStatus(status, tag, url);
        vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', url);
      }
    } else {
      // Clear build status if no CI configuration is found
      statusBarService.updateBuildStatus('', '', '');
      vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', '');
    }

    if (unreleasedCommits > 0) {
      statusBarService.updateStatusBar(
        statusBarText,
        tooltip,
        "extension.openCompareLink"
      );
    } else {
      statusBarService.updateStatusBar(statusBarText, tooltip);
    }
  } catch (error) {
    console.log("Error updating status bar:", error);
    statusBarService.clearStatusBar();
    showError(error, "Error fetching git data");
  }
}