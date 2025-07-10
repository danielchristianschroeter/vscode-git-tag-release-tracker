import * as vscode from "vscode";
import { Logger } from "./utils/logger";
import { globals } from "./globals";
import { initializeServices, validateCIConfiguration } from "./servicesManager";
import { registerCommands } from "./commandManager";
import { StatusBarService } from "./services/statusBarService";
import { GitExtension, Repository } from "./types/git";

function debounce<F extends (...args: any[]) => any>(func: F, wait: number): (...args: Parameters<F>) => void {
    let timeout: NodeJS.Timeout | undefined;

    return function(this: ThisParameterType<F>, ...args: Parameters<F>): void {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

export async function activate(context: vscode.ExtensionContext) {
  globals.context = context;
  Logger.initialize(context);
  Logger.log("Activating extension...", "INFO");

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration("gitTagReleaseTracker.ciProviders")) {
        Logger.log("CI Provider configuration changed, validating...", "INFO");
        await validateCIConfiguration();
      }
    })
  );

  try {
    const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension) {
      throw new Error("Git extension not found.");
    }
    const gitApi = gitExtension.exports.getAPI(1);
    
    let commandsRegistered = false;

    const debouncedInitialize = debounce(async () => {
      Logger.log("Git repositories changed, re-initializing.", "INFO");
      await initializeServices();
      if (!globals.statusBarService) {
        globals.statusBarService = new StatusBarService(context, globals.repositoryServices);
      }
      if (!commandsRegistered) {
        registerCommands();
        commandsRegistered = true;
      }
      globals.statusBarService.reloadEverything(true);
    }, 500);

    // Initial load
    if (gitApi.state === "initialized") {
        debouncedInitialize();
    }

    // Set up listeners for repo changes
    context.subscriptions.push(gitApi.onDidOpenRepository(repo => {
        Logger.log(`Repository opened: ${repo.rootUri.fsPath}`, "INFO");
        debouncedInitialize();
    }));

    context.subscriptions.push(gitApi.onDidCloseRepository(repo => {
        Logger.log(`Repository closed: ${repo.rootUri.fsPath}`, "INFO");
        debouncedInitialize();
    }));

    // Re-initialize when workspace folders are added/removed
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        Logger.log("Workspace folders changed, re-initializing services.", "INFO");
        debouncedInitialize();
      })
    );

    // Update on save for git files
    const updateOnSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.fileName.includes(".git") && globals.statusBarService) {
        globals.statusBarService.triggerUpdate(true);
      }
    });
    context.subscriptions.push(updateOnSave);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Error initializing Git Tag Release Tracker: ${errorMessage}`);
    Logger.log(`Initialization error: ${errorMessage}`, "ERROR");
    if (error instanceof Error && error.stack) {
      Logger.log(error.stack, 'ERROR');
    }
  }
}

export function deactivate() {
  const multiRepoService = globals.statusBarService?.getMultiRepoService();
  if (multiRepoService) {
    multiRepoService.stopPolling();
  }
}
