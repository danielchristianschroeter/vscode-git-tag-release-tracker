import * as vscode from "vscode";
import {globals} from "./globals";
import {createTag} from "./commands/createTag";
import {pushAndCheckBuild} from "./commands/pushAndCheckBuild";
import {createStatusBarUpdater} from "./utils/statusBarUpdater";
import {Logger} from "./utils/logger";

export function registerCommands() {
  const refreshAfterPush = async () => {
    if (globals.gitService && globals.statusBarService && globals.ciService) {
      await pushAndCheckBuild(globals.gitService, globals.statusBarService, globals.ciService);
      const statusBarUpdater = createStatusBarUpdater(globals.gitService, globals.statusBarService);
      await statusBarUpdater.updateNow();
    }
  };

  const commands = {
    "extension.createMajorTag": async () => {
      if (globals.gitService && globals.statusBarService && globals.ciService) {
        const defaultBranch = await globals.gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("major", globals.gitService, globals.statusBarService, defaultBranch, globals.ciService);
        }
      }
    },
    "extension.createMinorTag": async () => {
      if (globals.gitService && globals.statusBarService && globals.ciService) {
        const defaultBranch = await globals.gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("minor", globals.gitService, globals.statusBarService, defaultBranch, globals.ciService);
        }
      }
    },
    "extension.createPatchTag": async () => {
      if (globals.gitService && globals.statusBarService && globals.ciService) {
        const defaultBranch = await globals.gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("patch", globals.gitService, globals.statusBarService, defaultBranch, globals.ciService);
        }
      }
    },
    "extension.createInitialTag": async () => {
      if (globals.gitService && globals.statusBarService && globals.ciService) {
        const defaultBranch = await globals.gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("initial", globals.gitService, globals.statusBarService, defaultBranch, globals.ciService);
        }
      }
    },
    "extension.openCompareLink": () => {
      if (globals.statusBarService) {
        const url = globals.statusBarService.getCompareUrl();
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          vscode.window.showErrorMessage("No compare link available.");
        }
      }
    },
    "extension.openTagBuildStatus": () => {
      if (globals.statusBarService) {
        const url = globals.statusBarService.getTagBuildStatusUrl();
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          vscode.window.showErrorMessage("No tag build status URL available.");
        }
      }
    },
    "extension.openBranchBuildStatus": () => {
      if (globals.statusBarService) {
        const url = globals.statusBarService.getBranchBuildStatusUrl();
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          vscode.window.showErrorMessage("No branch build status URL available.");
        }
      }
    },
    "extension.pushAndCheckBuild": refreshAfterPush
  };

  for (const [commandId, handler] of Object.entries(commands)) {
    globals.context!.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  }

  const showLogsCommand = vscode.commands.registerCommand("gitTagReleaseTracker.showLogs", () => {
    Logger.show();
  });

  globals.context!.subscriptions.push(showLogsCommand);
}
