import * as vscode from "vscode";
import { GitService } from "./services/gitService";
import { StatusBarService } from "./services/statusBarService";
import { createInterval } from "./utils/intervalHandler";
import { createTag } from "./commands/createTag";
import { createInitialTag } from "./commands/createInitialTag";
import { openCompareLink } from "./commands/openCompareLink";
import { updateStatusBar } from "./utils/statusBarUpdater";
import { CIService } from "./services/ciService";
import { debounce } from "./utils/debounce";

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
  const ciService = new CIService();

  const config = vscode.workspace.getConfiguration("git-tag-release-tracker");
  const defaultBranch = config.get<string>("defaultBranch", "main");

  const updateStatusBarCallback = async () => {
    console.log("Updating status bar...");
    try {
      await updateStatusBar(gitService, statusBarService, defaultBranch, ciService);
    } catch (error) {
      console.log("Error updating status bar:", error);
    }
  };

  // Debounce the update function
  const debouncedUpdateStatusBar = debounce(updateStatusBarCallback, 300);

  // Run immediately on activation
  updateStatusBarCallback();

  // Run when the active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      debouncedUpdateStatusBar();
    })
  );

  // Run when the document is saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      debouncedUpdateStatusBar();
    })
  );

  // Then run every 30 seconds
  const intervalId = setInterval(updateStatusBarCallback, 30000);

  let buildStatusUrl = '';

  registerCommands(context, gitService, statusBarService, defaultBranch, ciService);

  gitService.initializeGit().then(updateStatusBarCallback);

  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    gitService.initializeGit().then(updateStatusBarCallback);
  });

  const intervalDisposable = createInterval(updateStatusBarCallback, 35000);
  context.subscriptions.push(intervalDisposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.openBuildStatus', () => {
      if (buildStatusUrl) {
        vscode.env.openExternal(vscode.Uri.parse(buildStatusUrl));
      } else {
        vscode.window.showErrorMessage('No build status URL available.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitTagReleaseTracker._buildStatusUrl', (url: string) => {
      buildStatusUrl = url;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitTagReleaseTracker.getBuildStatusUrl', () => {
      return vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.createAndPushVersionTag', async (version: string) => {
      try {
        const { owner, repo } = await gitService.getOwnerAndRepo();
        if (!owner || !repo) {
          throw new Error('Unable to determine owner and repo');
        }

        await gitService.createTagInternal(version);

        // Update status bar after pushing the tag
        await updateStatusBar(gitService, statusBarService, defaultBranch, ciService);

        vscode.window.showInformationMessage(`Version ${version} tag created and pushed successfully.`);

        // Start polling for build status
        pollBuildStatus(version, gitService, statusBarService, ciService);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create and push version tag: ${error.message}`);
      }
    })
  );

  context.subscriptions.push({
    dispose: () => clearInterval(intervalId)
  });
}

function registerCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string,
  ciService: CIService
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.createMajorTag", () =>
      createTag("major", gitService, statusBarService, defaultBranch, ciService)
    ),
    vscode.commands.registerCommand("extension.createMinorTag", () =>
      createTag("minor", gitService, statusBarService, defaultBranch, ciService)
    ),
    vscode.commands.registerCommand("extension.createPatchTag", () =>
      createTag("patch", gitService, statusBarService, defaultBranch, ciService)
    ),
    vscode.commands.registerCommand("extension.createInitialTag", () =>
      createInitialTag(gitService, statusBarService, defaultBranch, ciService)
    ),
    vscode.commands.registerCommand("extension.openCompareLink", () =>
      openCompareLink(gitService, statusBarService)
    )
  );
}

export function deactivate() {}

async function pollBuildStatus(tag: string, gitService: GitService, statusBarService: StatusBarService, ciService: CIService, maxAttempts = 30) {
  const ciType = gitService.detectCIType();
  if (!ciType) {
    console.log('No CI configuration detected, skipping build status check');
    return;
  }

  let attempts = 0;
  const pollInterval = setInterval(async () => {
    attempts++;
    try {
      const { owner, repo } = await gitService.getOwnerAndRepo();
      if (!owner || !repo) {
        throw new Error('Unable to determine owner and repo');
      }

      const { status, url } = await ciService.getBuildStatus(tag, owner, repo, ciType);
      console.log(`pollBuildStatus received status: ${status} for tag: ${tag}`);
      statusBarService.updateBuildStatus(status, tag, url);
      vscode.commands.executeCommand('gitTagReleaseTracker._buildStatusUrl', url);

      if (['completed', 'success', 'failure', 'cancelled', 'action_required', 'neutral', 'skipped', 'stale', 'timed_out'].includes(status) || attempts >= maxAttempts) {
        console.log(`Stopping poll for tag ${tag} with final status: ${status}`);
        clearInterval(pollInterval);
      }
    } catch (error) {
      console.error('Error polling build status:', error);
      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
      }
    }
  }, 10000); // Poll every 10 seconds
}