import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { showError } from "../utils/errorHandler";

export async function openCompareLink(
  gitService: GitService
) {
  try {
    const remotes = await gitService.getRemotes();
    const remote = remotes.find((r) => r.name === "origin");
    if (!remote) {
      vscode.window.showErrorMessage('Remote "origin" not found.');
      return;
    }
    const currentBranch = gitService.getCurrentBranch();
    const tagsResult = await gitService.fetchAndTags();

    // Ensure tagsResult and latest are properly checked
    if (!tagsResult || !tagsResult.latest) {
      const remoteUrl = remote.refs.fetch.replace(".git", "");
      const commitsUrl = `${remoteUrl}/commits/${currentBranch}`;
      vscode.env.openExternal(vscode.Uri.parse(commitsUrl));
      return;
    }

    const latestTag = tagsResult.latest;
    if (!latestTag) {
      return;
    }

    const remoteUrl = remote.refs.fetch.replace(".git", "");
    const compareUrl = `${remoteUrl}/compare/${latestTag}...${currentBranch}`;

    vscode.env.openExternal(vscode.Uri.parse(compareUrl));
  } catch (error) {
    showError(error, "Error opening compare link");
  }
}
