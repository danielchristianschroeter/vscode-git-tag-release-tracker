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
  private currentRepoPath = "";
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

  public async initializeGit(): Promise<boolean> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return false;
    }

    const filePath = activeEditor.document.uri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    
    if (!workspaceFolder) {
      return false;
    }

    const newRepoPath = workspaceFolder.uri.fsPath;
    if (this.currentRepoPath === newRepoPath && this.git) {
      return false; // No change in repository
    }

    this.currentRepoPath = newRepoPath;
    this.git = simpleGit({ baseDir: this.currentRepoPath });
    
    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        this.git = undefined;
        this.currentRepoPath = "";
        return false;
      }
    } catch (error) {
      console.error("Error checking if directory is a git repository:", error);
      this.git = undefined;
      this.currentRepoPath = "";
      return false;
    }

    this.cachedTags = null;
    this.currentBranch = "";
    this.currentRepo = path.basename(this.currentRepoPath);
    console.log("Git initialized for:", this.currentRepoPath);
    await this.getRemotes();
    return true;
  }

  public async createTagInternal(tag: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }
    try {
      await this.git.addTag(tag);
      console.log(`Tag ${tag} created locally`);
    } catch (error) {
      console.error(`Error creating tag ${tag}:`, error);
      throw error;
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
    try {
      await this.git.fetch(["--prune", "--prune-tags"]);
      this.cachedTags = await this.git.tags();
      console.log("Tags fetched:", this.cachedTags);
      return this.cachedTags;
    } catch (error) {
      console.log("Error fetching tags:", error);
      return null;
    }
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

  public async getUnreleasedCommits(latestTag: string, currentBranch: string): Promise<number> {
    if (!this.git) {
      return 0;
    }
    try {
      const result = await this.git.raw(['rev-list', '--count', `${latestTag}..${currentBranch}`]);
      return parseInt(result.trim(), 10);
    } catch (error) {
      console.error('Error getting unreleased commits:', error);
      return 0;
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

  public async pushTag(tag: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }
    try {
      await this.git?.push('origin', tag);
      console.log(`Tag ${tag} pushed to remote`);
    } catch (error) {
      console.error(`Error pushing tag ${tag}:`, error);
      throw error;
    }
  }

  async getRemoteUrl(): Promise<string> {
    try {
      const remotes = await this.git?.getRemotes(true);
      console.log('All remotes:', remotes);
      const originRemote = remotes?.find(remote => remote.name === 'origin');
      if (originRemote) {
        console.log('Origin remote:', originRemote);
        return originRemote.refs.push || originRemote.refs.fetch || '';
      }
      return '';
    } catch (error) {
      console.error('Error getting remote URL:', error);
      return '';
    }
  }

  async getOwnerAndRepo(): Promise<{ owner: string, repo: string }> {
    try {
      const remoteUrl = await this.getRemoteUrl();
      console.log('Remote URL:', remoteUrl);

      // Use a regex that handles URLs with authentication tokens
      const match = remoteUrl.match(/(?:https?:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:)([^\/]+)\/([^\/\.]+)(?:\.git)?/);

      if (match) {
        const [, owner, repo] = match;
        console.log('Extracted owner and repo:', { owner, repo });
        return { owner, repo };
      } else {
        throw new Error(`Unable to extract owner and repo from remote URL: ${remoteUrl}`);
      }
    } catch (error) {
      console.error('Error getting owner and repo:', error);
      throw error;
    }
  }

  public async hasCIConfiguration(): Promise<'github' | 'gitlab' | null> {
    if (!this.currentRepoPath) {
      return null;
    }

    const githubWorkflowsPath = path.join(this.currentRepoPath, '.github', 'workflows');
    const gitlabCIPath = path.join(this.currentRepoPath, '.gitlab-ci.yml');

    try {
      if (fs.existsSync(githubWorkflowsPath) && fs.statSync(githubWorkflowsPath).isDirectory()) {
        return 'github';
      } else if (fs.existsSync(gitlabCIPath) && fs.statSync(gitlabCIPath).isFile()) {
        return 'gitlab';
      }
    } catch (error) {
      console.error('Error checking CI configuration:', error);
    }

    return null;
  }

  public detectCIType(): 'github' | 'gitlab' | null {
    if (!this.currentRepoPath) {
      return null;
    }

    const githubWorkflowsPath = path.join(this.currentRepoPath, '.github', 'workflows');
    const gitlabCIPath = path.join(this.currentRepoPath, '.gitlab-ci.yml');

    if (fs.existsSync(githubWorkflowsPath) && fs.statSync(githubWorkflowsPath).isDirectory()) {
      return 'github';
    } else if (fs.existsSync(gitlabCIPath) && fs.statSync(gitlabCIPath).isFile()) {
      return 'gitlab';
    }

    return null;
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