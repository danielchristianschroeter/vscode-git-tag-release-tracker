import * as vscode from "vscode";
import {Logger} from "./utils/logger";
import {globals, RepositoryServices} from "./globals";
import {GitService} from "./services/gitService";
import {CIService} from "./services/ciService";
import {StatusBarService} from "./services/statusBarService";
import {createStatusBarUpdater} from "./utils/statusBarUpdater";
import { WorkspaceService } from "./services/workspaceService";
import * as path from "path";

/**
 * Detect Git repositories in the current VS Code workspace and make sure every
 * repository has its own GitService / CIService instance registered in the
 * global repositoryServices map.
 *
 * This function is SAFE to call multiple times – it will:
 *   1. Add services for any newly-detected repositories that are not yet in
 *      the map.
 *   2. Dispose and remove services that belong to repositories no longer
 *      present in the workspace.
 *
 * Status-bar data/caches are automatically refreshed by callers *after* this
 * function completes, therefore we do not trigger UI updates here directly.
 */
export async function initializeServices() {

  const workspaceService = new WorkspaceService();
  const repoRoots = await workspaceService.getGitRepositoryRoots();
  const uniqueRepoRoots = [...new Set(repoRoots)]; // De-duplicate

  // 1) Remove repositories that no longer exist in workspace -----------------
  for (const existingRoot of Array.from(globals.repositoryServices.keys())) {
    if (!uniqueRepoRoots.includes(existingRoot)) {
      const services = globals.repositoryServices.get(existingRoot);
      if (services) {
        services.gitService.dispose();
      }
      globals.repositoryServices.delete(existingRoot);
      Logger.log(`Removed services for closed repository: ${existingRoot}`, "INFO");
    }
  }

  if (uniqueRepoRoots.length === 0) {
    Logger.log("No Git repositories found in this workspace.", "WARNING");
    return;
  }

  const initializedRoots: string[] = [];

  // 2) Add new repositories ---------------------------------------------------
  for (const root of uniqueRepoRoots) {
    // Skip roots we already have services for
    if (globals.repositoryServices.has(root)) {
      continue;
    }

    // Skip sub-repositories inside already managed super-repositories
    if (initializedRoots.some(initializedRoot => root.startsWith(initializedRoot + path.sep))) {
      continue;
    }

    const gitService = new GitService(globals.context!, root);
    const gitInitialized = await gitService.initialize();

    if (!gitInitialized) {
      Logger.log(`GitService failed to initialize for ${root}.`, "WARNING");
      continue;
    }

    initializedRoots.push(root);

    let ciService: CIService | null = null;
    const ownerAndRepo = await gitService.getOwnerAndRepo();
    if (ownerAndRepo) {
      ciService = new CIService(ownerAndRepo.owner, ownerAndRepo.repo);
    } else {
      Logger.log(`Could not determine owner and repo for ${root}. CI services will be unavailable.`, "WARNING");
    }

    globals.repositoryServices.set(root, { gitService, ciService: ciService as any });
    globals.context!.subscriptions.push(gitService);
    Logger.log(`Added services for new repository: ${root}`, "INFO");
  }

  globals.isInitialized = true; // Mark that at least one initialization has occurred
  Logger.log(`Repository service count: ${globals.repositoryServices.size}`, "INFO");
}

function setupStatusBarService() {
  // This function needs a complete refactoring to support multi-repo.
  // For now, it is commented out.
  /*
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
  */
}

export async function validateCIConfiguration() {
  for (const [root, services] of globals.repositoryServices.entries()) {
    if (services.gitService && services.ciService) {
      // Reload CI providers to ensure we have the latest configuration
      services.ciService.reloadProviders();

      const ciType = await services.gitService.detectCIType();
      const config = vscode.workspace.getConfiguration("gitTagReleaseTracker");
      const ciProviders = config.get<{[key: string]: {token: string; apiUrl: string}}>("ciProviders", {});

      if (ciType && (!ciProviders[ciType]?.token || !ciProviders[ciType]?.apiUrl)) {
        Logger.log(`CI Provider ${ciType} is not properly configured for ${root}.`, "WARNING");
        vscode.window.showErrorMessage(`CI Provider ${ciType} is not properly configured for repository ${root}.`);
      } else if (ciType) {
        Logger.log(`CI Provider ${ciType} is properly configured for ${root}.`, "INFO");
      }
    }
  }
}

export function clearStatusBarAndState() {
  if (globals.statusBarService) {
    globals.statusBarService.clearAllItems(); // Clear all status bar items
  }
  for (const services of globals.repositoryServices.values()) {
    services.gitService.dispose();
  }
  globals.repositoryServices.clear();
  globals.isInitialized = false;
}
