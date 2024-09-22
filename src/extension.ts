import * as vscode from "vscode";
import { GitService } from "./services/gitService";
import { StatusBarService } from "./services/statusBarService";
import { createInterval } from "./utils/intervalHandler";
import { createTag } from "./commands/createTag";
import { createInitialTag } from "./commands/createInitialTag";
import { openCompareLink } from "./commands/openCompareLink";
import { updateStatusBar } from "./utils/statusBarUpdater";

export function activate(context: vscode.ExtensionContext) {
  const gitService = new GitService();
  const statusBarService = new StatusBarService(
    [
      "extension.createMajorTag",
      "extension.createMinorTag",
      "extension.createPatchTag",
      "extension.createInitialTag",
    ],
    context
  );

  const config = vscode.workspace.getConfiguration("git-tag-release-tracker");
  const defaultBranch = config.get<string>("defaultBranch", "main");

  const updateStatusBarCallback = async () => {
    console.log("Updating status bar...");
    try {
      await updateStatusBar(gitService, statusBarService, defaultBranch);
    } catch (error) {
      console.log("Error updating status bar:", error);
    }
  };

  registerCommands(context, gitService, statusBarService, defaultBranch);

  gitService.initializeGit().then(updateStatusBarCallback);

  vscode.workspace.onDidSaveTextDocument(() => updateStatusBarCallback());
  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    gitService.initializeGit().then(updateStatusBarCallback);
  });
  vscode.window.onDidChangeActiveTextEditor(() => {
    gitService.initializeGit().then(updateStatusBarCallback);
  });

  const intervalDisposable = createInterval(updateStatusBarCallback, 35000);
  context.subscriptions.push(intervalDisposable);
}

function registerCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.createMajorTag", () =>
      createTag("major", gitService, statusBarService, defaultBranch)
    ),
    vscode.commands.registerCommand("extension.createMinorTag", () =>
      createTag("minor", gitService, statusBarService, defaultBranch)
    ),
    vscode.commands.registerCommand("extension.createPatchTag", () =>
      createTag("patch", gitService, statusBarService, defaultBranch)
    ),
    vscode.commands.registerCommand("extension.createInitialTag", () =>
      createInitialTag(gitService, statusBarService, defaultBranch)
    ),
    vscode.commands.registerCommand("extension.openCompareLink", () =>
      openCompareLink(gitService, statusBarService)
    )
  );
}

export function deactivate() {}
