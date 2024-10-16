import * as vscode from "vscode";
import {GitService} from "./services/gitService";
import {StatusBarService} from "./services/statusBarService";
import {CIService} from "./services/ciService";
import {createTag} from "./commands/createTag";
import {createStatusBarUpdater} from "./utils/statusBarUpdater";
import {pushAndCheckBuild} from "./commands/pushAndCheckBuild";
import {Logger} from "./utils/logger";
import {debounce} from "./utils/debounce";

let gitService: GitService | null = null;
let statusBarService: StatusBarService | null = null;
let ciService: CIService;

export async function activate(context: vscode.ExtensionContext) {
  // Initialize the logger
  Logger.initialize(context);

  Logger.log("Activating extension...", "INFO");
  let isInitialized = false;
  // Function to initialize GitService and StatusBarService
  const initializeServices = async () => {
    if (isInitialized) {
      return; // Prevent reinitialization
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (workspaceFolder) {
        if (!gitService) {
          gitService = new GitService(context);
          const gitInitialized = await gitService.initialize();
          if (!gitInitialized) {
            Logger.log("GitService failed to initialize, continuing without it.", "WARNING");
            gitService = null; // Ensure gitService is null if initialization fails
            clearStatusBarAndState();
          } else {
            context.subscriptions.push(gitService);
            setupStatusBarService(context);
            isInitialized = true;
          }
        }
      } else {
        Logger.log("No active repository detected. Please open a file within a Git repository.", "WARNING");
      }
    }
  };

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
  registerCommands(context);

  // Set up interval to update status bar
  const config = vscode.workspace.getConfiguration("git-tag-release-tracker");
}

function setupStatusBarService(context: vscode.ExtensionContext) {
  if (gitService) {
    ciService = new CIService();
    statusBarService = new StatusBarService(
      [
        "extension.createMajorTag",
        "extension.createMinorTag",
        "extension.createPatchTag",
        "extension.createInitialTag",
        "extension.openCompareLink"
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
  } else {
    Logger.log("GitService is not initialized, skipping status bar setup.", "WARNING");
  }
}

function registerCommands(context: vscode.ExtensionContext) {
  const refreshAfterPush = async () => {
    if (gitService && statusBarService && ciService) {
      await pushAndCheckBuild(gitService, statusBarService, ciService);
      const statusBarUpdater = createStatusBarUpdater(gitService, statusBarService);
      await statusBarUpdater.updateNow();
    }
  };

  const commands = {
    "extension.createMajorTag": async () => {
      if (gitService && statusBarService && ciService) {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("major", gitService, statusBarService, defaultBranch, ciService);
        }
      }
    },
    "extension.createMinorTag": async () => {
      if (gitService && statusBarService && ciService) {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("minor", gitService, statusBarService, defaultBranch, ciService);
        }
      }
    },
    "extension.createPatchTag": async () => {
      if (gitService && statusBarService && ciService) {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("patch", gitService, statusBarService, defaultBranch, ciService);
        }
      }
    },
    "extension.createInitialTag": async () => {
      if (gitService && statusBarService && ciService) {
        const defaultBranch = await gitService.getDefaultBranch();
        if (defaultBranch) {
          return createTag("initial", gitService, statusBarService, defaultBranch, ciService);
        }
      }
    },
    "extension.openCompareLink": () => {
      if (statusBarService) {
        const url = statusBarService.getCompareUrl();
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          vscode.window.showErrorMessage("No compare link available.");
        }
      }
    },
    "extension.openTagBuildStatus": () => {
      if (statusBarService) {
        const url = statusBarService.getTagBuildStatusUrl();
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          vscode.window.showErrorMessage("No tag build status URL available.");
        }
      }
    },
    "extension.openBranchBuildStatus": () => {
      if (statusBarService) {
        const url = statusBarService.getBranchBuildStatusUrl();
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
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  }

  const showLogsCommand = vscode.commands.registerCommand("gitTagReleaseTracker.showLogs", () => {
    Logger.show();
  });

  context.subscriptions.push(showLogsCommand);
}

export function deactivate() {
  if (gitService) {
    gitService.dispose();
  }
}

async function validateCIConfiguration() {
  // Check if gitService is initialized
  if (!gitService) {
    Logger.log("GitService is not initialized, skipping CI configuration validation.", "WARNING");
    return; // Exit if gitService is not initialized
  }

  // Reload CI providers to ensure we have the latest configuration
  if (ciService) {
    ciService.reloadProviders();
  }

  const ciType = await gitService.detectCIType();
  const config = vscode.workspace.getConfiguration("gitTagReleaseTracker");
  const ciProviders = config.get<{[key: string]: {token: string; apiUrl: string}}>("ciProviders", {});

  if (ciType && (!ciProviders[ciType]?.token || !ciProviders[ciType]?.apiUrl)) {
    Logger.log(`CI Provider ${ciType} is not properly configured.`, "WARNING");
    vscode.window.showErrorMessage(`CI Provider ${ciType} is not properly configured.`);
  } else {
    Logger.log(`CI Provider ${ciType} is properly configured.`, "INFO");
  }
}

function clearStatusBarAndState() {
  if (statusBarService) {
    statusBarService.clearAllItems(); // Clear all status bar items
  }
  if (gitService) {
    gitService.dispose(); // Dispose of gitService
    gitService = null; // Reset gitService
  }
}
