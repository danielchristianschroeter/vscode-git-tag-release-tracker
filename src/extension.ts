import * as vscode from "vscode";
import {Logger} from "./utils/logger";
import {debounce} from "./utils/debounce";
import {globals} from "./globals";
import {initializeServices, validateCIConfiguration} from "./servicesManager";
import {registerCommands} from "./commandManager";

export async function activate(context: vscode.ExtensionContext) {
  globals.context = context;
  // Initialize the logger
  Logger.initialize(context);

  Logger.log("Activating extension...", "INFO");

  // Add a listener for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration("gitTagReleaseTracker.ciProviders")) {
        Logger.log("CI Provider configuration changed, validating...", "INFO");
        await validateCIConfiguration();
      }
    })
  );

  // Initial attempt to initialize services
  await initializeServices();

  // Debounce the function to handle active editor changes
  const debouncedInitializeServices = debounce(async () => {
    Logger.log("Active editor changed, attempting to initialize services...", "INFO");
    await initializeServices();
  }, 3000); // Adjust the debounce delay as needed

  // Listen for changes in the active text editor
  vscode.window.onDidChangeActiveTextEditor(debouncedInitializeServices);

  // Register commands once
  registerCommands();

  // Set up interval to update status bar
  const config = vscode.workspace.getConfiguration("git-tag-release-tracker");
}

export function deactivate() {
  if (globals.gitService) {
    globals.gitService.dispose();
  }
}
