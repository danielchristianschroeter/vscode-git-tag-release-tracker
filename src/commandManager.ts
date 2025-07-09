import * as vscode from "vscode";
import {globals} from "./globals";
import {createTag} from "./commands/createTag";
import {pushAndCheckBuild} from "./commands/pushAndCheckBuild";
import {createStatusBarUpdater} from "./utils/statusBarUpdater";
import {Logger} from "./utils/logger";
import { RepositoryServices } from "./globals";
import path from "path";

async function withRepoSelection(callback: (services: RepositoryServices, repoRoot: string) => Promise<void>) {
  const repoRoots = Array.from(globals.repositoryServices.keys());
  let selectedRepoRoot: string | undefined;

  if (repoRoots.length === 0) {
    vscode.window.showErrorMessage("No Git repositories found in the workspace.");
    return;
  }
  
  if (repoRoots.length === 1) {
    selectedRepoRoot = repoRoots[0];
  } else {
    const picks = repoRoots.map(root => ({
      label: path.basename(root),
      description: root,
      root: root
    })).sort((a, b) => a.label.localeCompare(b.label));
    const selectedPick = await vscode.window.showQuickPick(picks, {
      placeHolder: "Select a repository"
    });
    if (selectedPick) {
      selectedRepoRoot = selectedPick.root;
    }
  }

  if (selectedRepoRoot) {
    const services = globals.repositoryServices.get(selectedRepoRoot);
    if (services && services.gitService && services.ciService) {
      await callback(services, selectedRepoRoot);
    } else {
      vscode.window.showErrorMessage(`Could not find services for repository: ${selectedRepoRoot}`);
    }
  }
}

async function withSpecificRepo(repoRoot: string | undefined, callback: (services: RepositoryServices, repoRoot: string) => Promise<void>) {
  // If a specific repoRoot is provided, use it directly.
  if (repoRoot) {
    const services = globals.repositoryServices.get(repoRoot);
    if (services && services.gitService && services.ciService) {
      await callback(services, repoRoot);
      return;
    } else {
      vscode.window.showErrorMessage(`Could not find services for repository: ${repoRoot}`);
      return;
    }
  }

  // If no repoRoot is provided, try to infer from the active editor.
  if (vscode.window.activeTextEditor?.document.uri) {
    const activeFilePath = vscode.window.activeTextEditor.document.uri.fsPath;
    const repoRoots = Array.from(globals.repositoryServices.keys());
    const inferredRepoRoot = repoRoots.find(root => activeFilePath.startsWith(root));
    if (inferredRepoRoot) {
      const services = globals.repositoryServices.get(inferredRepoRoot);
      if (services && services.gitService && services.ciService) {
        await callback(services, inferredRepoRoot);
        return;
      }
    }
  }

  // If still no repository, fall back to selection.
  return withRepoSelection(callback);
}

export function registerCommands() {
  // TODO: This function needs to be refactored for multi-repo support.
  // The concept of a single gitService/ciService is deprecated.
  // Commands should likely operate on the "active" repository,
  // or prompt the user to select a repository.
  
  const refreshAfterPush = async () => {
    // if (globals.gitService && globals.statusBarService && globals.ciService) {
    //   await pushAndCheckBuild(globals.gitService, globals.statusBarService, globals.ciService);
    //   const statusBarUpdater = createStatusBarUpdater(globals.gitService, globals.statusBarService);
    //   await statusBarUpdater.updateNow();
    // }
    Logger.log("TODO: refreshAfterPush needs multi-repo implementation", "WARNING");
  };

  const commands = {
    "extension.createMajorTag": async (...cmdArgs: any[]) => {
      let repoRoot: string | undefined;
      if (cmdArgs.length === 1 && Array.isArray(cmdArgs[0])) {
        repoRoot = cmdArgs[0][0];
      } else if (cmdArgs.length > 0 && typeof cmdArgs[0] === 'string') {
        repoRoot = cmdArgs[0];
      }
      
      await withSpecificRepo(repoRoot, async ({ gitService }) => {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch && globals.statusBarService) {
          await createTag("major", gitService, globals.statusBarService, defaultBranch);
        }
      });
    },
    "extension.createMinorTag": async (...cmdArgs: any[]) => {
      let repoRoot: string | undefined;
      if (cmdArgs.length === 1 && Array.isArray(cmdArgs[0])) {
        repoRoot = cmdArgs[0][0];
      } else if (cmdArgs.length > 0 && typeof cmdArgs[0] === 'string') {
        repoRoot = cmdArgs[0];
      }
      
      await withSpecificRepo(repoRoot, async ({ gitService }) => {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch && globals.statusBarService) {
          await createTag("minor", gitService, globals.statusBarService, defaultBranch);
        }
      });
    },
    "extension.createPatchTag": async (...cmdArgs: any[]) => {
      let repoRoot: string | undefined;
      if (cmdArgs.length === 1 && Array.isArray(cmdArgs[0])) {
        repoRoot = cmdArgs[0][0];
      } else if (cmdArgs.length > 0 && typeof cmdArgs[0] === 'string') {
        repoRoot = cmdArgs[0];
      }
      
      await withSpecificRepo(repoRoot, async ({ gitService }) => {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch && globals.statusBarService) {
          await createTag("patch", gitService, globals.statusBarService, defaultBranch);
        }
      });
    },
    "extension.createInitialTag": async (...cmdArgs: any[]) => {
      let repoRoot: string | undefined;
      if (cmdArgs.length === 1 && Array.isArray(cmdArgs[0])) {
        repoRoot = cmdArgs[0][0];
      } else if (cmdArgs.length > 0 && typeof cmdArgs[0] === 'string') {
        repoRoot = cmdArgs[0];
      }
      
      await withSpecificRepo(repoRoot, async ({ gitService }) => {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch && globals.statusBarService) {
          await createTag("initial", gitService, globals.statusBarService, defaultBranch);
        }
      });
    },
    "extension.openCompareLink": async (...cmdArgs: any[]) => {
      let repoRoot: string | undefined;
      let base: string | undefined;
      let head: string | undefined;

      // Robustly parse arguments, which can be passed in different ways by VS Code.
      let effectiveArgs: any[] = [];
      if (cmdArgs.length === 1 && Array.isArray(cmdArgs[0])) {
        // Handles cases where args are wrapped in an outer array, e.g., [['/path', 'main']]
        effectiveArgs = cmdArgs[0];
      } else {
        // Handles cases where args are passed directly, e.g., ['/path', 'main']
        effectiveArgs = cmdArgs;
      }
      [repoRoot, base, head] = effectiveArgs;


      // Fallback logic if no repoRoot is provided via args
      if (!repoRoot && vscode.window.activeTextEditor?.document.uri) {
        const activeFilePath = vscode.window.activeTextEditor.document.uri.fsPath;
        const repoRoots = Array.from(globals.repositoryServices.keys());
        repoRoot = repoRoots.find(root => activeFilePath.startsWith(root));
      }

      // If still no repoRoot, prompt the user
      if (!repoRoot) {
        const repoRoots = Array.from(globals.repositoryServices.keys());
        if (repoRoots.length === 1) {
          repoRoot = repoRoots[0];
        } else if (repoRoots.length > 1) {
          const picks = repoRoots.map(root => ({
            label: path.basename(root),
            description: root,
            root: root
          }));
          const selectedPick = await vscode.window.showQuickPick(picks, {
            placeHolder: "Select a repository to compare changes"
          });
          if (selectedPick) {
            repoRoot = selectedPick.root;
          }
        }
      }

      if (!repoRoot) {
        vscode.window.showErrorMessage("No repository selected or found.");
        return;
      }
      
      if (!globals.statusBarService) {
        vscode.window.showErrorMessage("Status bar service is not available.");
        return;
      }

      const repoName = path.basename(repoRoot);
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Generating compare URL for ${repoName}...`,
        cancellable: false
      }, async () => {
        try {
          const url = await globals.statusBarService!.getCompareUrlForRepo(repoRoot!, base, head);
          if (url) {
            vscode.env.openExternal(vscode.Uri.parse(url));
          } else {
            vscode.window.showWarningMessage(`Could not generate a compare URL for ${repoName}.`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Failed to open compare link for ${repoName}: ${errorMessage}`);
          Logger.log(`Error in openCompareLink for ${repoRoot}: ${errorMessage}`, "ERROR");
        }
      });
    },
    "extension.openBranchBuildStatus": (url: string) => {
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showInformationMessage("No build status URL available for the current branch.");
      }
    },
    "extension.openTagBuildStatus": (url: string) => {
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showInformationMessage("No build status URL available for the latest tag.");
      }
    },
    "extension.pushAndCheckBuild": async () => {
      await withRepoSelection(async ({ gitService }, _repoRoot) => {
        if (globals.statusBarService) {
          await pushAndCheckBuild(gitService, globals.statusBarService);
        }
      });
    },
    "extension.refreshDashboard": async () => {
      if (globals.statusBarService) {
        await globals.statusBarService.reloadEverything(true);
        vscode.window.showInformationMessage("Git Tag Release Tracker dashboard refreshed.");
      } else {
        vscode.window.showErrorMessage("Status bar service is not available.");
      }
    }
  };

  for (const [commandId, handler] of Object.entries(commands)) {
    globals.context!.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  }

  const showLogsCommand = vscode.commands.registerCommand("gitTagReleaseTracker.showLogs", () => {
    Logger.show();
  });

  globals.context!.subscriptions.push(showLogsCommand);
}
