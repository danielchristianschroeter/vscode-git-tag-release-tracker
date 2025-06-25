import * as vscode from "vscode";
import {Logger} from "./utils/logger";
import {globals} from "./globals";
import {GitService} from "./services/gitService";
import {CIService} from "./services/ciService";
import {StatusBarService} from "./services/statusBarService";
import {createStatusBarUpdater} from "./utils/statusBarUpdater";

export async function initializeServices() {
  if (globals.isInitialized) {
    return; // Prevent reinitialization
  }
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (workspaceFolder) {
      if (!globals.gitService) {
        globals.gitService = new GitService(globals.context!);
        const gitInitialized = await globals.gitService.initialize();
        if (!gitInitialized) {
          Logger.log("GitService failed to initialize, continuing without it.", "WARNING");
          globals.gitService = null; // Ensure gitService is null if initialization fails
          clearStatusBarAndState();
        } else {
          globals.context!.subscriptions.push(globals.gitService);
          setupStatusBarService();
          globals.isInitialized = true;
        }
      }
    } else {
      Logger.log("No active repository detected. Please open a file within a Git repository.", "WARNING");
    }
  }
}

function setupStatusBarService() {
  if (globals.gitService) {
    globals.ciService = new CIService();
    globals.statusBarService = new StatusBarService(
      [
        "extension.createMajorTag",
        "extension.createMinorTag",
        "extension.createPatchTag",
        "extension.createInitialTag",
        "extension.openCompareLink"
      ],
      globals.context!,
      globals.gitService,
      globals.ciService
    );

    const statusBarUpdater = createStatusBarUpdater(globals.gitService, globals.statusBarService);

    // Add a listener for active text editor changes
    vscode.window.onDidChangeActiveTextEditor(() => {
      statusBarUpdater.debouncedUpdate(false);
    });
  } else {
    Logger.log("GitService is not initialized, skipping status bar setup.", "WARNING");
  }
}

export async function validateCIConfiguration() {
  // Check if gitService is initialized
  if (!globals.gitService) {
    Logger.log("GitService is not initialized, skipping CI configuration validation.", "WARNING");
    return; // Exit if gitService is not initialized
  }

  // Reload CI providers to ensure we have the latest configuration
  if (globals.ciService) {
    globals.ciService.reloadProviders();
  }

  const ciType = await globals.gitService.detectCIType();
  const config = vscode.workspace.getConfiguration("gitTagReleaseTracker");
  const ciProviders = config.get<{[key: string]: {token: string; apiUrl: string}}>("ciProviders", {});

  if (ciType && (!ciProviders[ciType]?.token || !ciProviders[ciType]?.apiUrl)) {
    Logger.log(`CI Provider ${ciType} is not properly configured.`, "WARNING");
    vscode.window.showErrorMessage(`CI Provider ${ciType} is not properly configured.`);
  } else {
    Logger.log(`CI Provider ${ciType} is properly configured.`, "INFO");
  }
}

export function clearStatusBarAndState() {
  if (globals.statusBarService) {
    globals.statusBarService.clearAllItems(); // Clear all status bar items
  }
  if (globals.gitService) {
    globals.gitService.dispose(); // Dispose of gitService
    globals.gitService = null; // Reset gitService
  }
}
