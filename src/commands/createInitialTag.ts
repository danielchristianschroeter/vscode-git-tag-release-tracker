import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { showError } from "../utils/errorHandler";
import { updateStatusBar } from "../utils/statusBarUpdater";

export async function createInitialTag(
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string
) {
  try {
    await gitService.createTagInternal("1.0.0");
    vscode.window.showInformationMessage(
      "Created and pushed initial tag: 1.0.0"
    );
    await updateStatusBar(gitService, statusBarService, defaultBranch);
  } catch (error) {
    showError(error, "Error creating initial tag");
  }
}
