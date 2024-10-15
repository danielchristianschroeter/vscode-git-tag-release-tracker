import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { StatusBarService } from "../services/statusBarService";
import { handleError } from "./errorHandler";
import { debounce } from "./debounce";
import { Logger } from './logger';

let lastUpdateRepo: string | null = null;

export async function updateStatusBar(
  gitService: GitService,
  statusBarService: StatusBarService,
  forceRefresh: boolean = false
) {
  try {
    Logger.log("Updating status bar...", 'INFO');
    if (!gitService.isInitialized()) {
      Logger.log("GitService is not initialized, attempting to initialize...", 'INFO');
      const initialized = await gitService.initialize();
      if (!initialized) {
        Logger.log("Failed to initialize GitService, skipping status bar update", 'ERROR');
        return;
      }
    }

    const currentRepo = await gitService.getCurrentRepo();
    if (currentRepo !== lastUpdateRepo) {
      forceRefresh = true;
      lastUpdateRepo = currentRepo;
      Logger.log(`Repository changed to: ${currentRepo}. Forcing refresh.`, 'INFO');
    }

    // Update everything in the status bar
    await statusBarService.updateEverything(forceRefresh);
    Logger.log("Status bar updated successfully", 'INFO');

  } catch (error) {
    Logger.log(`Error updating status bar: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
    handleError(error, "Error updating status bar");
  }
}

export function createStatusBarUpdater(
  gitService: GitService,
  statusBarService: StatusBarService
) {
  const updateStatusBarCallback = async (forceRefresh: boolean = false) => {
    try {
      await updateStatusBar(gitService, statusBarService, forceRefresh);
    } catch (error) {
      Logger.log(`Error updating status bar: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      handleError(error, "Error updating status bar");
    }
  };

  const debouncedUpdateStatusBar = debounce((forceRefresh: boolean = false) => updateStatusBarCallback(forceRefresh), 2000);

  return {
    updateNow: updateStatusBarCallback,
    debouncedUpdate: debouncedUpdateStatusBar
  };
}
