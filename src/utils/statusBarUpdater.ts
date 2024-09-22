import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { showError } from "./errorHandler";
import * as semver from "semver";

export async function updateStatusBar(
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string
) {
  if (!gitService) {
    return;
  }

  console.log("Fetching and tags...");
  try {
    const tagsResult = await gitService.fetchAndTags();
    const branchDetected = await gitService.detectBranch();

    if (!branchDetected) {
      console.log("No branch detected.");
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
      return;
    }

    const [, prefix, major, minor, patch, suffix] = tagMatch;
    const commits = await gitService.getCommits(
      tagsResult.latest,
      currentBranch
    );
    if (!commits) {
      return;
    }

    const latestVersion = `${prefix}${major}.${minor}.${patch}${suffix}`;
    const statusBarText = `${currentRepo}/${currentBranch} | ${commits.total} unreleased commits | ${latestVersion}`;
    const tooltip = `${commits.total} unreleased commits for ${currentRepo}/${currentBranch} | Latest version: ${latestVersion}`;

    statusBarService.updateStatusBar(statusBarText, tooltip);

    if (currentBranch === defaultBranch && commits.total > 0) {
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

    if (commits.total > 0) {
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
    showError(error, "Error fetching git data");
  }
}
