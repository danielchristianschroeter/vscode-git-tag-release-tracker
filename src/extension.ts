import * as vscode from "vscode";
import { GitService } from "./services/gitService";
import { StatusBarService } from "./services/statusBarService";
import { createInterval } from "./utils/intervalHandler";
import { createTag } from "./commands/createTag";
import { createInitialTag } from "./commands/createInitialTag";
import { openCompareLink } from "./commands/openCompareLink";
import { createStatusBarUpdater } from "./utils/statusBarUpdater";
import { CIService } from "./services/ciService";
import { pushAndCheckBuild } from "./commands/pushAndCheckBuild";

let buildStatusUrl: string | undefined;
let branchBuildStatusUrl: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Git Tag Release Tracker extension');

  const gitService = new GitService();
  const ciService = new CIService();

  const config = vscode.workspace.getConfiguration("git-tag-release-tracker");
  const defaultBranch = config.get<string>("defaultBranch", "main");

  const statusBarService = new StatusBarService(
    [
      "extension.createMajorTag",
      "extension.createMinorTag",
      "extension.createPatchTag",
      "extension.createInitialTag",
      "extension.refreshBranchBuildStatus",
    ],
    context,
    gitService,
    ciService
  );

  const statusBarUpdater = createStatusBarUpdater(gitService, statusBarService, defaultBranch, ciService);

  gitService.onRepoChanged((newRepo) => {
    console.log('Repository changed, updating status bar');
    statusBarService.clearBuildStatus();
    const [owner, repo] = newRepo.split('/');
    ciService.clearCacheForRepo(owner, repo);
    statusBarUpdater.updateNow();
  });

  // Run immediately on activation
  statusBarUpdater.updateNow();

  // Run when the active editor changes or document is saved
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(statusBarUpdater.debouncedUpdate),
    vscode.workspace.onDidSaveTextDocument(statusBarUpdater.debouncedUpdate)
  );

  // Set up interval to update status bar
  const updateInterval = config.get<number>("refreshInterval", 30) * 1000; // Convert to milliseconds
  const intervalDisposable = createInterval(statusBarUpdater.updateNow, updateInterval);
  context.subscriptions.push(intervalDisposable);

  // Initial setup
  gitService.initializeGit().then(statusBarUpdater.updateNow);

  // Listen for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      gitService.initializeGit().then(statusBarUpdater.updateNow);
    })
  );

  registerCommands(context, gitService, statusBarService, defaultBranch, ciService, statusBarUpdater);
}

function registerCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  statusBarService: StatusBarService,
  defaultBranch: string,
  ciService: CIService,
  statusBarUpdater: { updateNow: () => Promise<void> }
) {
  const commands = {
    'extension.createMajorTag': () => createTag("major", gitService, statusBarService, defaultBranch, ciService),
    'extension.createMinorTag': () => createTag("minor", gitService, statusBarService, defaultBranch, ciService),
    'extension.createPatchTag': () => createTag("patch", gitService, statusBarService, defaultBranch, ciService),
    'extension.createInitialTag': () => createInitialTag(gitService, statusBarService, defaultBranch, ciService),
    'extension.openCompareLink': () => openCompareLink(gitService),
    'extension.openBuildStatus': () => openBuildStatus(),
    'extension.openBranchBuildStatus': () => openBranchBuildStatus(),
    'extension.createAndPushVersionTag': (version: string) => createAndPushVersionTag(version, gitService, statusBarService, ciService, statusBarUpdater),
    'extension.pushAndCheckBuild': () => pushAndCheckBuild(gitService, statusBarService, ciService),
    'extension.refreshBranchBuildStatus': () => statusBarService.refreshCIStatus(),
    'gitTagReleaseTracker._buildStatusUrl': (url: string) => { buildStatusUrl = url; },
    'gitTagReleaseTracker._branchBuildStatusUrl': (url: string) => { branchBuildStatusUrl = url; },
  };

  for (const [commandId, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  }
}

function openBuildStatus() {
  if (buildStatusUrl) {
    vscode.env.openExternal(vscode.Uri.parse(buildStatusUrl));
  } else {
    vscode.window.showErrorMessage('No build status URL available.');
  }
}

function openBranchBuildStatus() {
  if (branchBuildStatusUrl) {
    vscode.env.openExternal(vscode.Uri.parse(branchBuildStatusUrl));
  } else {
    vscode.window.showErrorMessage('No branch build status URL available.');
  }
}

async function createAndPushVersionTag(
  version: string,
  gitService: GitService,
  statusBarService: StatusBarService,
  ciService: CIService,
  statusBarUpdater: { updateNow: () => Promise<void> }
) {
  try {
    const { owner, repo } = await gitService.getOwnerAndRepo();
    if (!owner || !repo) {
      throw new Error('Unable to determine owner and repo');
    }

    await gitService.createTagInternal(version);
    await statusBarUpdater.updateNow();
    vscode.window.showInformationMessage(`Version ${version} tag created and pushed successfully.`);
    pollBuildStatus(version, gitService, statusBarService, ciService);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create and push version tag: ${(error as Error).message}`);
  }
}

async function pollBuildStatus(tag: string, gitService: GitService, statusBarService: StatusBarService, ciService: CIService, maxAttempts = 30) {
  console.log(`Starting pollBuildStatus for tag: ${tag}`);
  
  const ciType = gitService.detectCIType();
  if (!ciType) {
    console.log('No CI configuration detected, skipping build status check');
    return;
  }

  console.log(`Detected CI type: ${ciType}`);

  let attempts = 0;
  const pollInterval = setInterval(async () => {
    attempts++;
    console.log(`Poll attempt ${attempts} for tag: ${tag}`);
    
    try {
      const { owner, repo } = await gitService.getOwnerAndRepo();
      if (!owner || !repo) {
        throw new Error('Unable to determine owner and repo');
      }

      console.log(`Fetching build status for ${owner}/${repo}, tag: ${tag}`);
      const { status, url } = await ciService.getBuildStatus(tag, owner, repo, ciType, true);
      console.log(`Received status: ${status} for tag: ${tag}`);
      
      statusBarService.updateBuildStatus(status, tag, url, repo);
      buildStatusUrl = url;

      if (['completed', 'success', 'failure', 'cancelled', 'action_required', 'neutral', 'skipped', 'stale', 'timed_out', 'no_runs'].includes(status) || attempts >= maxAttempts) {
        console.log(`Stopping poll for tag ${tag} with final status: ${status}`);
        clearInterval(pollInterval);
      }
    } catch (error) {
      console.error('Error polling build status:', error);
      if (attempts >= maxAttempts) {
        console.log(`Max attempts reached for tag ${tag}, stopping poll`);
        clearInterval(pollInterval);
      }
    }
  }, 10000); // Poll every 10 seconds
}

export function deactivate() {}