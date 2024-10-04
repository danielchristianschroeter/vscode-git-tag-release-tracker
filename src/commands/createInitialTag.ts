import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { showError } from "../utils/errorHandler";
import { updateStatusBar } from "../utils/statusBarUpdater";
import { CIService } from "../services/ciService";
import { checkBuildStatus } from "../utils/ciUtils";

export async function createInitialTag(
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string,
  ciService: CIService
) {
  try {
    await gitService.createTagInternal("1.0.0");
    await gitService.pushTag("1.0.0");
    vscode.window.showInformationMessage(
      "Created and pushed initial tag: 1.0.0"
    );
    await updateStatusBar(gitService, statusBarService, defaultBranch, ciService);
    
    // Get owner and repo here
    const { owner, repo } = await gitService.getOwnerAndRepo();
    if (!owner || !repo) {
      throw new Error('Unable to determine owner and repo');
    }
    
    checkBuildStatus("1.0.0", owner, repo, ciService, statusBarService, gitService);
  } catch (error) {
    showError(error, "Error creating initial tag");
  }
}
