import simpleGit, {
  SimpleGit,
  TagResult,
  LogResult,
  DefaultLogFields,
} from "simple-git";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export class GitService {
  private git: SimpleGit | undefined;
  private currentBranch = "";
  private currentRepo = "";
  private cachedTags: TagResult | null = null;

  constructor() {
    this.initializeGit();
    this.setupEventListeners();
  }

  private setupEventListeners() {
    vscode.window.onDidChangeActiveTextEditor(() => this.initializeGit());
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.initializeGit());
    vscode.workspace.onDidSaveTextDocument(() => this.initializeGit());
  }

  public async initializeGit() {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const filePath = activeEditor.document.uri.fsPath;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(
        activeEditor.document.uri
      );
      if (workspaceFolder && isGitDirectory(workspaceFolder.uri.fsPath)) {
        this.git = simpleGit({ baseDir: workspaceFolder.uri.fsPath });
        this.cachedTags = null; // Clear cached tags when initializing a new repository
        console.log("Git initialized for:", workspaceFolder.uri.fsPath);
        await this.getRemotes(); // Update currentRepo
      } else {
        this.git = undefined;
        console.log("No Git repository found in the workspace.");
      }
    } else {
      this.git = undefined;
      console.log("No active editor found.");
    }
  }

  public async createTagInternal(tag: string) {
    if (this.git) {
      await this.git.addTag(tag);
      await this.git.pushTags();
    }
  }

  public async detectBranch(): Promise<boolean> {
    if (!this.git) {
      return false;
    }
    try {
      this.currentBranch = await this.git.revparse(["--abbrev-ref", "HEAD"]);
      console.log("Current branch detected:", this.currentBranch);
      return true;
    } catch (error) {
      console.log("Error detecting branch:", error);
      return false;
    }
  }

  public async fetchAndTags(): Promise<TagResult | null> {
    if (!this.git) {
      return null;
    }
    if (!this.cachedTags) {
      try {
        await this.git.fetch(["--prune", "--prune-tags"]);
        this.cachedTags = await this.git.tags();
        console.log("Tags fetched:", this.cachedTags);
      } catch (error) {
        console.log("Error fetching tags:", error);
        return null;
      }
    }
    return this.cachedTags;
  }

  public async getCommits(
    from: string,
    to: string
  ): Promise<LogResult<DefaultLogFields> | null> {
    if (!this.git) {
      return null;
    }
    try {
      const commits = await this.git.log({ from, to });
      if (commits.total === 0 && from === to) {
        console.log("No tags found; fetching all commits from initial commit.");
        const allCommits = await this.git.log(["--all"]);
        return allCommits;
      }
      console.log(`Commits between ${from} and ${to} fetched:`, commits);
      return commits;
    } catch (error) {
      console.log("Error fetching commits:", error);
      return null;
    }
  }

  public getCurrentBranch() {
    return this.currentBranch;
  }

  public getCurrentRepo() {
    return this.currentRepo;
  }

  public async getRemotes() {
    if (!this.git) {
      return [];
    }
    const remotes = await this.git.getRemotes(true);
    const remote = remotes.find((r) => r.name === "origin");
    if (remote) {
      const remoteUrl = remote.refs.fetch.replace(".git", "");
      this.currentRepo = remoteUrl.split("/").pop() || "";
      console.log("Current repo detected:", this.currentRepo);
    }
    return remotes;
  }

  public clearCachedTags() {
    this.cachedTags = null;
  }
}

function isGitDirectory(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch (error) {
    console.log("Error checking Git directory:", error);
    return false;
  }
}
