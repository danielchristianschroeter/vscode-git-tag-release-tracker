import * as vscode from "vscode";
import { GitService } from "./services/gitService";
import { StatusBarService } from "./services/statusBarService";
import { CIService } from "./services/ciService";
import { createTag } from "./commands/createTag";
import { createStatusBarUpdater } from "./utils/statusBarUpdater";
import { pushAndCheckBuild } from "./commands/pushAndCheckBuild";
import { Logger } from './utils/logger';

let gitService: GitService;
let statusBarService: StatusBarService;
let ciService: CIService;

export async function activate(context: vscode.ExtensionContext) {
  // Initialize the logger
  Logger.initialize(context);

  Logger.log("Activating extension...", 'INFO');

  gitService = new GitService(context);
  await gitService.initialize();
  context.subscriptions.push(gitService);

  ciService = new CIService();
  statusBarService = new StatusBarService(
    [
      "extension.createMajorTag",
      "extension.createMinorTag",
      "extension.createPatchTag",
      "extension.createInitialTag",
      "extension.openCompareLink",
    ],
    context,
    gitService,
    ciService
  );

  const statusBarUpdater = createStatusBarUpdater(gitService, statusBarService);

  // Add a listener for active text editor changes
  vscode.window.onDidChangeActiveTextEditor(() => {
    statusBarUpdater.debouncedUpdate(false);
  });

  // Register commands
  registerCommands(context, gitService, statusBarService, ciService, statusBarUpdater);

  // Set up interval to update status bar
  const config = vscode.workspace.getConfiguration("git-tag-release-tracker");
}

function registerCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  statusBarService: StatusBarService,
  ciService: CIService,
  statusBarUpdater: { 
    updateNow: (forceRefresh?: boolean) => Promise<void>,
    debouncedUpdate: (forceRefresh?: boolean) => void 
  }
) {
  const refreshAfterPush = async () => {
    await pushAndCheckBuild(gitService, statusBarService, ciService);
    await statusBarUpdater.updateNow();
  };

  const commands = {
    'extension.createMajorTag': async () => {
      const defaultBranch = await gitService.getDefaultBranch();
      if (defaultBranch) {
        return createTag("major", gitService, statusBarService, defaultBranch, ciService);
      }
    },
    'extension.createMinorTag': async () => {
      const defaultBranch = await gitService.getDefaultBranch();
      if (defaultBranch) {
        return createTag("minor", gitService, statusBarService, defaultBranch, ciService);
      }
    },
    'extension.createPatchTag': async () => {
      const defaultBranch = await gitService.getDefaultBranch();
      if (defaultBranch) {
        return createTag("patch", gitService, statusBarService, defaultBranch, ciService);
      }
    },
    'extension.createInitialTag': async () => {
      const defaultBranch = await gitService.getDefaultBranch();
      if (defaultBranch) {
      return createTag("initial", gitService, statusBarService, defaultBranch, ciService);
      }
    },
    'extension.openCompareLink': () => {
      const url = statusBarService.getCompareUrl();
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showErrorMessage('No compare link available.');
      }
    },
    'extension.openTagBuildStatus': () => {
      const url = statusBarService.getTagBuildStatusUrl();
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showErrorMessage('No tag build status URL available.');
      }
    },
    'extension.openBranchBuildStatus': () => {
      const url = statusBarService.getBranchBuildStatusUrl();
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showErrorMessage('No branch build status URL available.');
      }
    },
    'extension.pushAndCheckBuild': refreshAfterPush,
  };

  for (const [commandId, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  }

  const showLogsCommand = vscode.commands.registerCommand('gitTagReleaseTracker.showLogs', () => {
    Logger.show();
  });

  context.subscriptions.push(showLogsCommand);
}
export function deactivate() {
  if (gitService) {
    gitService.dispose();
  }
}
