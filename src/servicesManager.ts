import * as vscode from "vscode";
import {Logger} from "./utils/logger";
import {globals, RepositoryServices} from "./globals";
import {GitService} from "./services/gitService";
import {CIService} from "./services/ciService";
import {StatusBarService} from "./services/statusBarService";
import {createStatusBarUpdater} from "./utils/statusBarUpdater";
import { WorkspaceService } from "./services/workspaceService";
import * as path from "path";

export async function initializeServices() {
  if (globals.isInitialized) {
    return; // Prevent reinitialization
  }

  const workspaceService = new WorkspaceService();
  const repoRoots = await workspaceService.getGitRepositoryRoots();
  const uniqueRepoRoots = [...new Set(repoRoots)]; // Remove duplicates

  if (uniqueRepoRoots.length === 0) {
    Logger.log("No Git repositories found in this workspace.", "WARNING");
    return;
  }

  const initializedRoots: string[] = [];

  for (const root of uniqueRepoRoots) {
    // Check if this root is a subdirectory of an already initialized repo
    if (initializedRoots.some(initializedRoot => root.startsWith(initializedRoot + path.sep))) {
        continue;
    }
    
    const gitService = new GitService(globals.context!, root);
    const gitInitialized = await gitService.initialize();

    if (gitInitialized) {
      initializedRoots.push(root); // Add to our list of initialized roots
      const ownerAndRepo = await gitService.getOwnerAndRepo();
      if (ownerAndRepo) {
        const ciService = new CIService(ownerAndRepo.owner, ownerAndRepo.repo);
        globals.repositoryServices.set(root, { gitService, ciService });
        globals.context!.subscriptions.push(gitService);
      } else {
        Logger.log(`Could not determine owner and repo for ${root}. CI services will be unavailable.`, "WARNING");
        // Still add gitService even if owner/repo can't be found for git-only features.
        globals.repositoryServices.set(root, { gitService, ciService: null as any });
        globals.context!.subscriptions.push(gitService);
      }
    } else {
      Logger.log(`GitService failed to initialize for ${root}.`, "WARNING");
    }
  }

  if (globals.repositoryServices.size > 0) {
    // setupStatusBarService(); // This will be refactored later
    globals.isInitialized = true;
    Logger.log(`Initialized services for ${globals.repositoryServices.size} repositories.`, "INFO");
  }
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
