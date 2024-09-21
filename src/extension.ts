import * as vscode from "vscode";
import simpleGit, { SimpleGit } from "simple-git";
import * as semver from "semver";
import * as fs from "fs";
import * as path from "path";

let git: SimpleGit | undefined;
let currentRepo: string = "";
let currentBranch: string = "";
let lastFetchTime: number = 0;
const FETCH_INTERVAL = 30000; // Polling interval in milliseconds

export function activate(context: vscode.ExtensionContext) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  const majorButton = createStatusButton(
    "extension.createMajorTag",
    99,
    context
  );
  const minorButton = createStatusButton(
    "extension.createMinorTag",
    98,
    context
  );
  const patchButton = createStatusButton(
    "extension.createPatchTag",
    97,
    context
  );
  const initialTagButton = createStatusButton(
    "extension.createInitialTag",
    96,
    context
  );

  context.subscriptions.push(
    statusBarItem,
    majorButton,
    minorButton,
    patchButton,
    initialTagButton
  );

  const config = vscode.workspace.getConfiguration("git-tag-release-tracker");
  const defaultBranch = config.get<string>("defaultBranch", "main");

  registerCommands(
    context,
    statusBarItem,
    majorButton,
    minorButton,
    patchButton,
    initialTagButton,
    defaultBranch
  );

  function onWorkspaceChange() {
    initializeGit();
    updateStatusBar(
      statusBarItem,
      majorButton,
      minorButton,
      patchButton,
      initialTagButton,
      defaultBranch
    );
  }

  // Ensure proper initialization and updates
  vscode.workspace.onDidChangeWorkspaceFolders(onWorkspaceChange);
  vscode.window.onDidChangeActiveTextEditor(onWorkspaceChange);

  // Hook into the periodic Git checks using a custom Disposable
  const intervalDisposable = createInterval(() => {
    initializeGit();
    updateStatusBar(
      statusBarItem,
      majorButton,
      minorButton,
      patchButton,
      initialTagButton,
      defaultBranch
    );
  }, FETCH_INTERVAL);
  context.subscriptions.push(intervalDisposable);

  initializeGit();
  updateStatusBar(
    statusBarItem,
    majorButton,
    minorButton,
    patchButton,
    initialTagButton,
    defaultBranch
  );
}

function createInterval(
  callback: () => void,
  interval: number
): vscode.Disposable {
  const handle = setInterval(callback, interval);
  return { dispose: () => clearInterval(handle) };
}

async function initializeGit() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const activeEditor = vscode.window.activeTextEditor;

  if (activeEditor && workspaceFolders) {
    const filePath = activeEditor.document.uri.fsPath;
    const workspaceFolder = workspaceFolders.find((folder) =>
      filePath.startsWith(folder.uri.fsPath)
    );
    if (workspaceFolder && isGitDirectory(workspaceFolder.uri.fsPath)) {
      git = simpleGit({ baseDir: workspaceFolder.uri.fsPath });
    } else {
      git = undefined;
    }
  } else {
    git = undefined;
  }
}

function createStatusButton(
  command: string,
  priority: number,
  context: vscode.ExtensionContext
) {
  const button = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    priority
  );
  button.command = command;
  context.subscriptions.push(button);
  return button;
}

function registerCommands(
  context: vscode.ExtensionContext,
  statusBarItem: vscode.StatusBarItem,
  majorButton: vscode.StatusBarItem,
  minorButton: vscode.StatusBarItem,
  patchButton: vscode.StatusBarItem,
  initialTagButton: vscode.StatusBarItem,
  defaultBranch: string
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.openCompareLink", async () => {
      if (git) {
        const tags = await git.tags();
        const latestTag = tags.latest ?? "0.0.0";
        const branch =
          currentBranch || (await git.revparse(["--abbrev-ref", "HEAD"]));
        const commits = await git.log({ from: latestTag, to: branch });
        if (commits.total > 0) {
          openCompareLink(currentRepo, branch, latestTag);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("extension.createMajorTag", () =>
      createTag(
        "major",
        statusBarItem,
        majorButton,
        minorButton,
        patchButton,
        initialTagButton,
        defaultBranch
      )
    ),
    vscode.commands.registerCommand("extension.createMinorTag", () =>
      createTag(
        "minor",
        statusBarItem,
        majorButton,
        minorButton,
        patchButton,
        initialTagButton,
        defaultBranch
      )
    ),
    vscode.commands.registerCommand("extension.createPatchTag", () =>
      createTag(
        "patch",
        statusBarItem,
        majorButton,
        minorButton,
        patchButton,
        initialTagButton,
        defaultBranch
      )
    ),
    vscode.commands.registerCommand("extension.createInitialTag", () =>
      createInitialTag(
        statusBarItem,
        majorButton,
        minorButton,
        patchButton,
        initialTagButton,
        defaultBranch
      )
    )
  );
}

function isGitDirectory(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

async function detectBranch(): Promise<boolean> {
  if (!git) {
    return false;
  }
  try {
    currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]);
    return true;
  } catch (error) {
    if (isTemporaryError(error as Error)) {
      return false;
    }
    currentBranch = "";
    return false;
  }
}

async function updateStatusBar(
  statusBarItem: vscode.StatusBarItem,
  majorButton: vscode.StatusBarItem,
  minorButton: vscode.StatusBarItem,
  patchButton: vscode.StatusBarItem,
  initialTagButton: vscode.StatusBarItem,
  defaultBranch: string
) {
  if (!git) {
    return;
  }

  try {
    // Fetch the latest data and update in-memory values
    await git.fetch(["--prune", "--prune-tags"]);
    lastFetchTime = Date.now();
    const branchDetected = await detectBranch();

    if (!branchDetected) {
      // If the branch could not be detected, show an error
      statusBarItem.text = "Invalid Git repository";
      statusBarItem.tooltip =
        "Git repository exists but the branch cannot be determined";
      statusBarItem.show();
      hideButtons([majorButton, minorButton, patchButton, initialTagButton]);
      return;
    }

    const remotes = await git.getRemotes(true);
    const remote = remotes.find((r) => r.name === "origin");
    const remoteUrl = remote ? remote.refs.fetch.replace(".git", "") : "";
    currentRepo = remoteUrl.split("/").pop() || "";

    const tags = await git.tags();
    const latestTag = tags.latest;

    if (!latestTag) {
      const commits = await git.log({ from: defaultBranch, to: currentBranch });
      statusBarItem.text = `$(git-commit) ${commits.total} unreleased commits | Create initial version tag 1.0.0`;
      statusBarItem.tooltip = `${commits.total} unreleased commits for ${currentRepo}/${currentBranch}`;
      statusBarItem.command = "extension.createInitialTag";
      statusBarItem.show();
      hideButtons([majorButton, minorButton, patchButton, initialTagButton]);
      return;
    }

    const tagMatch = latestTag.match(/^([^\d]*)(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (!tagMatch) {
      updateUI(
        statusBarItem,
        majorButton,
        minorButton,
        patchButton,
        initialTagButton,
        "No version tag with semantic versioning found"
      );
      return;
    }

    const [, prefix, major, minor, patch, suffix] = tagMatch;
    const commits = await git.log({ from: latestTag, to: currentBranch });

    let statusBarText = `$(git-commit) ${commits.total} unreleased commits | ${currentRepo}/${currentBranch} | Current Version:`;
    if (!(currentBranch === defaultBranch && commits.total > 0)) {
      statusBarText += ` ${latestTag}`;
    }

    statusBarItem.text = statusBarText;
    statusBarItem.tooltip = `${commits.total} unreleased commits for ${currentRepo}/${currentBranch} based on version ${latestTag}`;
    statusBarItem.show();

    if (currentBranch === defaultBranch && commits.total > 0) {
      updateButton(
        majorButton,
        minorButton,
        patchButton,
        prefix,
        major,
        minor,
        patch,
        suffix
      );
    } else {
      hideButtons([majorButton, minorButton, patchButton]);
    }

    if (commits.total > 0) {
      statusBarItem.command = "extension.openCompareLink";
    } else {
      statusBarItem.command = undefined;
    }
  } catch (error) {
    if (!isTemporaryError(error as Error)) {
      showError(error as Error, "Error fetching git data");
    }
  }
}

function hideButtons(buttons: vscode.StatusBarItem[]) {
  buttons.forEach((button) => button.hide());
}

async function autoRefreshTags(
  statusBarItem: vscode.StatusBarItem,
  majorButton: vscode.StatusBarItem,
  minorButton: vscode.StatusBarItem,
  patchButton: vscode.StatusBarItem,
  initialTagButton: vscode.StatusBarItem,
  defaultBranch: string
) {
  if (!git) {
    return;
  }

  try {
    await git.fetch(["--prune", "--prune-tags"]);
    lastFetchTime = Date.now();
    await updateStatusBar(
      statusBarItem,
      majorButton,
      minorButton,
      patchButton,
      initialTagButton,
      defaultBranch
    );
  } catch (error) {
    showError(error, "Error auto-refreshing tags");
  }
}

async function createInitialTag(
  statusBarItem: vscode.StatusBarItem,
  majorButton: vscode.StatusBarItem,
  minorButton: vscode.StatusBarItem,
  patchButton: vscode.StatusBarItem,
  initialTagButton: vscode.StatusBarItem,
  defaultBranch: string
) {
  try {
    await createTagInternal("1.0.0");
    vscode.window.showInformationMessage(
      "Created and pushed initial tag: 1.0.0"
    );
    await updateStatusBar(
      statusBarItem,
      majorButton,
      minorButton,
      patchButton,
      initialTagButton,
      defaultBranch
    );
  } catch (error) {
    showError(error, "Error creating initial tag");
  }
}

async function createTag(
  versionPart: "major" | "minor" | "patch",
  statusBarItem: vscode.StatusBarItem,
  majorButton: vscode.StatusBarItem,
  minorButton: vscode.StatusBarItem,
  patchButton: vscode.StatusBarItem,
  initialTagButton: vscode.StatusBarItem,
  defaultBranch: string
) {
  try {
    if (git) {
      const tags = await git.tags();
      const latestTag = tags.latest || "0.0.0";

      const tagMatch = latestTag.match(/^([^\d]*)(\d+\.\d+\.\d+)(.*)$/);
      if (!tagMatch) {
        throw new Error("Invalid tag format.");
      }

      const [, prefix, version, suffix] = tagMatch;
      const newVersion = semver.inc(version, versionPart);
      await createTagInternal(`${prefix || ""}${newVersion}${suffix || ""}`);
      vscode.window.showInformationMessage(
        `Created and pushed new tag: ${prefix || ""}${newVersion}${
          suffix || ""
        }`
      );
      await updateStatusBar(
        statusBarItem,
        majorButton,
        minorButton,
        patchButton,
        initialTagButton,
        defaultBranch
      );
    }
  } catch (error) {
    showError(error, "Error creating tag");
  }
}

async function createTagInternal(tag: string) {
  if (git) {
    await git.addTag(tag);
    await git.pushTags();
  }
}

function isTemporaryError(error: Error): boolean {
  const temporaryErrorMessages = [
    "Could not resolve host",
    "unable to access",
    "temporary failure",
    "network is unreachable",
  ];

  return temporaryErrorMessages.some((temporaryMsg) =>
    error.message.includes(temporaryMsg)
  );
}

function updateUI(
  statusBarItem: vscode.StatusBarItem,
  majorButton: vscode.StatusBarItem,
  minorButton: vscode.StatusBarItem,
  patchButton: vscode.StatusBarItem,
  initialTagButton: vscode.StatusBarItem,
  message: string
) {
  statusBarItem.text = message;
  statusBarItem.show();
  majorButton.hide();
  minorButton.hide();
  patchButton.hide();
  initialTagButton.hide();
}

function updateButton(
  majorButton: vscode.StatusBarItem,
  minorButton: vscode.StatusBarItem,
  patchButton: vscode.StatusBarItem,
  prefix: string,
  major: string,
  minor: string,
  patch: string,
  suffix: string
) {
  majorButton.text = `${major}`;
  minorButton.text = `${minor}`;
  patchButton.text = `${patch}`;
  majorButton.show();
  minorButton.show();
  patchButton.show();

  majorButton.tooltip = `Create and push major tag version ${prefix}${semver.inc(
    `${major}.${minor}.${patch}`,
    "major"
  )}${suffix}`;
  minorButton.tooltip = `Create and push minor tag version ${prefix}${semver.inc(
    `${major}.${minor}.${patch}`,
    "minor"
  )}${suffix}`;
  patchButton.tooltip = `Create and push patch version ${prefix}${semver.inc(
    `${major}.${minor}.${patch}`,
    "patch"
  )}${suffix}`;
}

async function openCompareLink(
  repo: string,
  branch: string,
  latestTag: string
) {
  try {
    if (git) {
      const remotes = await git.getRemotes(true);
      const remote = remotes.find((r) => r.name === "origin");
      if (!remote) {
        vscode.window.showErrorMessage('Remote "origin" not found.');
        return;
      }

      const remoteUrl = remote.refs.fetch.replace(".git", "");
      const compareUrl = `${remoteUrl}/compare/${latestTag}...${branch}`;

      vscode.env.openExternal(vscode.Uri.parse(compareUrl));
    }
  } catch (error) {
    showError(error, "Error opening compare link");
  }
}

function showError(error: unknown, message: string) {
  if (error instanceof Error) {
    vscode.window.showErrorMessage(`${message}: ${error.message}`);
  } else {
    vscode.window.showErrorMessage(`${message}: An unknown error occurred.`);
  }
}

export function deactivate() {}
