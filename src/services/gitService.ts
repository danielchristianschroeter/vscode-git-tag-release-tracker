import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {EventEmitter} from "vscode";
import {Logger} from "../utils/logger";
import simpleGit, {SimpleGit} from "simple-git";
import {debounce} from "../utils/debounce";
import {StatusBarService} from "./statusBarService";

export interface TagResult {
  latest: string | null;
}

export class GitService {
  private git: SimpleGit | null = null;
  private activeRepository: string | null = null;
  private currentBranch: string | null = null;
  private initialized: boolean = false;
  private _onRepoChanged = new EventEmitter<{
    oldRepo: string | null;
    newRepo: string | null;
    oldBranch: string | null;
    newBranch: string | null;
  }>();
  readonly onRepoChanged = this._onRepoChanged.event;
  private _onBranchChanged = new EventEmitter<{oldBranch: string | null; newBranch: string | null}>();
  readonly onBranchChanged = this._onBranchChanged.event;
  private _onGitPush = new vscode.EventEmitter<void>();
  readonly onGitPush = this._onGitPush.event;
  private defaultBranchCache: Map<string, string> = new Map();
  private cachedCIType: "github" | "gitlab" | null = null;
  private remoteUrlCache: {[key: string]: string} = {};
  private ownerRepoCache: {[key: string]: {owner: string; repo: string}} = {};
  private tagCache: {tags: TagResult | null; timestamp: number} = {tags: null, timestamp: 0};
  private readonly tagCacheDuration = 60000; // 1 minute
  private pushCheckInterval: NodeJS.Timeout | null = null;
  private branchPollingInterval: NodeJS.Timeout | null = null;
  private commitCountCache: {[key: string]: {count: number; timestamp: number}} = {};
  private readonly commitCountCacheDuration = 60000; // 1 minute
  private lastTagFetchRepo: string | null = null;
  private lastRepo: string | null = null;
  private lastBranch: string | null = null;
  private context: vscode.ExtensionContext;
  private debouncedHandleGitChange: () => void;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.updateActiveRepository();
    vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveRepository());
    this.startBranchPolling();
    this.debouncedHandleGitChange = debounce(this.handleGitChange.bind(this), 500);
  }

  private async updateActiveRepository() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      Logger.log("No active editor. Skipping repository update.", "WARNING");
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) {
      Logger.log("No workspace folder detected. Skipping repository update.", "WARNING");
      return;
    }

    const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      Logger.log("File is outside the workspace folder. Skipping repository update.", "WARNING");
      return;
    }

    const gitRoot = this.findGitRoot(filePath);

    if (!gitRoot) {
      if (this.activeRepository !== null) {
        Logger.log(`No Git repository found in ${filePath} or its parent directories. Clearing status bar.`, "WARNING");
        this._onRepoChanged.fire({
          oldRepo: this.activeRepository,
          newRepo: null,
          oldBranch: this.currentBranch,
          newBranch: null
        });
        this.activeRepository = null;
        this.git = null; // Clear the git instance
      }
      return; // Skip if no Git repository found
    }

    if (gitRoot !== this.activeRepository) {
      const oldRepo = this.activeRepository;
      this.activeRepository = gitRoot;
      this.git = simpleGit(this.activeRepository);
      this.initialized = false;
      await this.initialize();
      Logger.log(`Active repository changed to: ${this.activeRepository}`, "INFO");

      // Clear caches when repository changes
      this.clearCaches();

      // Emit repository change event
      const oldBranch = this.currentBranch;
      this.currentBranch = await this.getCurrentBranchInternal();
      this._onRepoChanged.fire({oldRepo, newRepo: gitRoot, oldBranch, newBranch: this.currentBranch});
    }
  }

  public async initialize(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    if (!this.activeRepository) {
      Logger.log("No active repository detected during initialization", "WARNING");
      return false;
    }

    try {
      const currentRepo = await this.getCurrentRepo();
      if (currentRepo !== this.lastRepo) {
        this.lastRepo = currentRepo;
        this.clearTagCache();
        Logger.log(`Repository changed to: ${currentRepo}. Tag cache cleared.`, "INFO");
      }

      await this.git?.status();
      this.initialized = true;
      this.currentBranch = await this.getCurrentBranchInternal();
      Logger.log(
        `Git initialized successfully for ${this.activeRepository}. Current branch: ${this.currentBranch}`,
        "INFO"
      );
      await this.watchGitChanges();
      return true;
    } catch (error) {
      Logger.log(`Failed to initialize Git: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      if (error instanceof Error && error.stack) {
        Logger.log(`Error stack: ${error.stack}`, "WARNING");
      }
      return false;
    }
  }
  public getActiveRepository(): string | null {
    return this.activeRepository;
  }
  public isInitialized(): boolean {
    return this.initialized;
  }

  async createTagInternal(tag: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }

    try {
      Logger.log(`Creating tag ${tag} locally...`, "INFO");
      await this.git.addAnnotatedTag(tag, `Release ${tag}`);
      Logger.log(`Tag ${tag} created locally`, "INFO");

      // Force update of the local tag list
      await this.git.tags(["--list"]);
    } catch (error) {
      Logger.log(`Error creating tag ${tag}: ${error instanceof Error ? error.message : String(error)}`, "ERROR");
      throw error;
    }
  }

  public async fetchAndTags(forceRefresh: boolean = false): Promise<TagResult> {
    const currentRepo = await this.getCurrentRepo();
    const currentBranch = await this.getCurrentBranch();

    if (currentRepo !== this.lastTagFetchRepo || currentBranch !== this.lastBranch) {
      this.lastTagFetchRepo = currentRepo;
      this.lastBranch = currentBranch;
      forceRefresh = true; // Force refresh when repo or branch changes
      this.clearTagCache();
    }

    const now = Date.now();
    if (!forceRefresh && this.tagCache.tags && now - this.tagCache.timestamp < this.tagCacheDuration) {
      Logger.log("Returning cached latest tag", "INFO");
      return this.tagCache.tags;
    }

    try {
      if (!this.git) {
        throw new Error("Git is not initialized");
      }

      Logger.log("Fetching latest tag from remote...", "INFO");
      await this.git.fetch(["--tags", "--prune", "--prune-tags"]);

      // Try to get the latest tag
      let latestTag: string | null = null;
      try {
        latestTag = await this.git.raw(["describe", "--tags", "--abbrev=0"]);
        latestTag = latestTag.trim();
      } catch (error) {
        // If no tags are found, this command will throw an error
        Logger.log("No tags found in the repository", "INFO");
      }

      const result: TagResult = {latest: latestTag};

      this.tagCache = {tags: result, timestamp: now};
      Logger.log(`Latest tag fetched and cached: ${JSON.stringify(result)}`, "INFO");
      return result;
    } catch (error) {
      Logger.log(`Error fetching tags: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      return {latest: null};
    }
  }

  public async getCommitCounts(from: string | null, to: string, forceRefresh: boolean = false): Promise<number> {
    const cacheKey = `${from}-${to}`;
    const now = Date.now();

    // Check cache first, unless forceRefresh is true
    if (
      !forceRefresh &&
      this.commitCountCache[cacheKey] &&
      now - this.commitCountCache[cacheKey].timestamp < this.commitCountCacheDuration
    ) {
      Logger.log(`Returning cached commit count for ${from} to ${to}`, "INFO");
      return this.commitCountCache[cacheKey].count;
    }

    try {
      if (!this.git) {
        throw new Error("Git is not initialized");
      }

      // Fetch the latest changes without tags to improve performance
      await this.git.fetch(["--no-tags"]);

      // Check if both 'from' and 'to' branches/refs exist
      const [fromExists, toExists] = await Promise.all([
        from ? this.refExists(from) : Promise.resolve(true),
        this.refExists(to)
      ]);

      Logger.log(`Checking ref existence - from: ${from} (${fromExists}), to: ${to} (${toExists})`, "INFO");

      // If either branch doesn't exist, return 0
      if (!fromExists || !toExists) {
        Logger.log(`Branch or ref does not exist: ${!fromExists ? from : to}`, "INFO");
        return 0;
      }

      const range = from ? `${from}..${to}` : to;
      const result = await this.git.raw(["rev-list", "--count", range]);
      const count = parseInt(result.trim(), 10);

      // Cache the result
      this.commitCountCache[cacheKey] = {count, timestamp: now};

      Logger.log(`Commit count from ${from} to ${to}: ${count}`, "INFO");
      return count;
    } catch (error) {
      Logger.log(`Error getting commit count: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      return 0;
    }
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git?.revparse(["--verify", ref]);
      return true;
    } catch (error) {
      return false;
    }
  }

  private findGitRoot(startPath: string): string | null {
    let currentPath = startPath;
    while (currentPath !== path.parse(currentPath).root) {
      const gitPath = path.join(currentPath, ".git");
      if (fs.existsSync(gitPath)) {
        return currentPath;
      }
      currentPath = path.dirname(currentPath);
    }
    return null;
  }

  public async getCurrentRepo(): Promise<string | null> {
    const currentRepo = this.activeRepository;
    if (!currentRepo || !this.findGitRoot(currentRepo)) {
      Logger.log("No valid Git repository detected. Clearing caches.", "WARNING");
      this.clearCaches();
      this.activeRepository = null;
      return null;
    }

    if (currentRepo !== this.lastRepo) {
      this.lastRepo = currentRepo;
      this.clearCaches();
      Logger.log(`Repository changed to: ${currentRepo}. Caches cleared.`, "INFO");
    }
    return currentRepo;
  }

  public async getRemotes() {
    if (!this.git) {
      return [];
    }
    const remotes = await this.git.getRemotes(true);
    const remote = remotes.find(r => r.name === "origin");
    if (remote) {
      const remoteUrl = remote.refs.fetch.replace(".git", "");
      this.activeRepository = remoteUrl.split("/").pop() || "";
    }
    return remotes;
  }

  async pushTag(tag: string, timeout: number = 30000): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }

    const timer = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Pushing tag ${tag} timed out after ${timeout / 1000} seconds`)), timeout)
    );

    try {
      Logger.log(`Verifying tag ${tag} exists locally...`, "INFO");
      const localTags = await this.git.tags();
      Logger.log(`Local tags: ${JSON.stringify(localTags)}`, "INFO");

      if (!localTags.all.includes(tag)) {
        throw new Error(`Tag ${tag} does not exist locally`);
      }

      const tagCommit = await this.git.raw(["rev-list", "-n", "1", tag]);
      Logger.log(`Tag ${tag} is associated with commit ${tagCommit.trim()}`, "INFO");

      Logger.log(`Pushing tag ${tag} to origin...`, "INFO");
      await Promise.race([this.git.push("origin", tag), timer]);
      Logger.log(`Tag ${tag} pushed successfully`, "INFO");

      // Verify the tag was pushed
      await this.git.fetch("origin", "--tags");
      const remoteTags = await this.git.tags(["--list", `${tag}`]);
      Logger.log(`Remote tags: ${JSON.stringify(remoteTags)}`, "INFO");

      if (!remoteTags.all.includes(tag)) {
        Logger.log(`Tag ${tag} not found in remote tags list. Waiting and retrying...`, "WARNING");
        // Wait for 5 seconds and try again
        await new Promise(resolve => setTimeout(resolve, 5000));
        const retryRemoteTags = await this.git.tags(["--list", `${tag}`]);
        Logger.log(`Retry remote tags: ${JSON.stringify(retryRemoteTags)}`, "INFO");

        if (!retryRemoteTags.all.includes(tag)) {
          throw new Error(`Failed to verify tag ${tag} on remote after retry`);
        }
      }

      Logger.log(`Tag ${tag} successfully pushed and verified on remote`, "INFO");
    } catch (error) {
      Logger.log(`Error pushing tag ${tag}: ${error instanceof Error ? error.message : String(error)}`, "ERROR");
      if (error instanceof Error && error.stack) {
        Logger.log(`Error stack: ${error.stack}`, "ERROR");
      }
      throw error;
    }
  }

  async getRemoteUrl(): Promise<string | undefined> {
    const cacheKey = this.activeRepository || "";
    if (this.remoteUrlCache[cacheKey]) {
      return this.remoteUrlCache[cacheKey];
    }

    if (!this.git) {
      Logger.log("Git is not initialized, ignoring", "WARNING");
      return undefined;
    }

    try {
      const remotes = await this.git.getRemotes(true);
      Logger.log(`All remotes: ${JSON.stringify(remotes)}`);

      const originRemote = remotes.find(remote => remote.name === "origin");
      if (originRemote) {
        Logger.log(`Origin remote URL: ${originRemote.refs.fetch}`);
        const remoteUrl = originRemote.refs.fetch;
        if (remoteUrl) {
          this.remoteUrlCache[cacheKey] = remoteUrl;
        }
        return remoteUrl;
      }

      Logger.log("No origin remote found, ignoring", "WARNING");
      return undefined;
    } catch (error) {
      Logger.log(`Error getting remote URL: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      return undefined;
    }
  }

  async getOwnerAndRepo(): Promise<{owner: string; repo: string} | undefined> {
    const remoteUrl = await this.getRemoteUrl();
    if (!remoteUrl) {
      return undefined;
    }

    if (this.ownerRepoCache[remoteUrl]) {
      return this.ownerRepoCache[remoteUrl];
    }

    try {
      if (!this.git) {
        Logger.log("Git is not initialized, ignoring", "WARNING");
        return undefined;
      }

      Logger.log(`Remote URL: ${remoteUrl}`);

      if (!remoteUrl) {
        Logger.log("No remote URL found, ignoring", "WARNING");
        return undefined;
      }

      // Handle HTTPS URLs (with or without credentials) and SSH URLs
      const urlPattern = /(?:https?:\/\/(?:[^@]+@)?|git@)((?:[\w.-]+\.)+[\w.-]+)[:/](.+?)\/([^/]+?)(?:\.git)?$/i;
      const match = remoteUrl.match(urlPattern);

      if (match) {
        const [, domain, fullPath, repo] = match;

        // Split the full path into parts
        const pathParts = fullPath.split("/");

        // The repo name is the last part, and everything else is the owner/group path
        const owner = pathParts.join("/");

        Logger.log(`Extracted owner and repo: ${owner}/${repo} (domain: ${domain})`);
        if (owner && repo) {
          this.ownerRepoCache[remoteUrl] = {owner, repo};
        }
        return {owner, repo};
      }

      Logger.log(`Unable to extract owner and repo from remote URL: ${remoteUrl}`, "WARNING");
      return undefined;
    } catch (error) {
      Logger.log(`Error getting owner and repo: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      return undefined;
    }
  }

  public async hasCIConfiguration(): Promise<"github" | "gitlab" | null> {
    if (!this.activeRepository) {
      return null;
    }

    const githubWorkflowsPath = path.join(this.activeRepository, ".github", "workflows");
    const gitlabCIPath = path.join(this.activeRepository, ".gitlab-ci.yml");

    try {
      if (fs.existsSync(githubWorkflowsPath) && fs.statSync(githubWorkflowsPath).isDirectory()) {
        return "github";
      } else if (fs.existsSync(gitlabCIPath) && fs.statSync(gitlabCIPath).isFile()) {
        return "gitlab";
      }
    } catch (error) {
      console.error("Error checking CI configuration:", error);
    }

    return null;
  }

  public detectCIType(): "github" | "gitlab" | null {
    if (this.cachedCIType !== null) {
      return this.cachedCIType;
    }

    if (!this.activeRepository) {
      return null;
    }

    const githubWorkflowsPath = path.join(this.activeRepository, ".github", "workflows");
    const gitlabCIPath = path.join(this.activeRepository, ".gitlab-ci.yml");

    if (fs.existsSync(githubWorkflowsPath) && fs.statSync(githubWorkflowsPath).isDirectory()) {
      this.cachedCIType = "github";
    } else if (fs.existsSync(gitlabCIPath) && fs.statSync(gitlabCIPath).isFile()) {
      this.cachedCIType = "gitlab";
    } else {
      this.cachedCIType = null;
    }

    return this.cachedCIType;
  }

  async pushChanges(branch: string): Promise<void> {
    await this.git?.push("origin", branch);
  }

  public async getDefaultBranch(): Promise<string | null> {
    if (!this.git) {
      Logger.log("Git is not initialized", "INFO");
      return null;
    }

    const currentRepo = await this.getCurrentRepo();
    if (!currentRepo) {
      Logger.log("Current repository not detected", "WARNING");
      return null;
    }

    // Check if the default branch is cached for the current repo
    const cachedDefaultBranch = this.defaultBranchCache.get(currentRepo);
    console.log("Cached Default Branch:", cachedDefaultBranch); // Debug log
    if (cachedDefaultBranch) {
      return cachedDefaultBranch;
    }

    try {
      // First, try to get the default branch from the origin remote
      const result = await this.git.raw(["remote", "show", "origin"]);
      console.log("Remote Show Result:", result); // Debug log
      const match = result.match(/HEAD branch: (.+)/);
      if (match) {
        const defaultBranch = match[1].trim();
        this.defaultBranchCache.set(currentRepo, `origin/${defaultBranch}`);
        return `origin/${defaultBranch}`;
      }

      // If that fails, fall back to checking common default branch names
      const commonDefaultBranches = ["main", "master", "develop"];
      for (const branch of commonDefaultBranches) {
        try {
          await this.git.raw(["rev-parse", "--verify", `origin/${branch}`]);
          this.defaultBranchCache.set(currentRepo, `origin/${branch}`);
          return `origin/${branch}`;
        } catch (error) {
          // Branch doesn't exist, continue to the next one
        }
      }

      // If all else fails, return the current branch as a default
      const currentBranch = await this.getCurrentBranchInternal();
      console.log("Current Branch:", currentBranch); // Debug log
      if (currentBranch) {
        Logger.log(`Unable to determine default branch, falling back to current branch "${currentBranch}"`, "WARNING");
        this.defaultBranchCache.set(currentRepo, currentBranch);
        return currentBranch;
      } else {
        Logger.log("Unable to determine current branch", "WARNING");
        return null;
      }
    } catch (error) {
      Logger.log(`Error getting default branch: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      throw error;
    }
  }

  public isAnyCIConfigured(): boolean {
    return this.detectCIType() !== null;
  }

  public async waitForInitialization(timeout = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.git && this.activeRepository) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  public async getInitialCommit(): Promise<string> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }
    try {
      const result = await this.git.raw(["rev-list", "--max-parents=0", "HEAD"]);
      return result.trim();
    } catch (error) {
      Logger.log(`Error getting initial commit: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      throw error;
    }
  }

  private startBranchPolling() {
    if (this.branchPollingInterval) {
      clearInterval(this.branchPollingInterval);
    }
    this.branchPollingInterval = setInterval(async () => {
      const newBranch = await this.getCurrentBranchInternal();
      if (newBranch !== this.currentBranch) {
        const oldBranch = this.currentBranch;
        this.currentBranch = newBranch;
        this._onBranchChanged.fire({oldBranch, newBranch});
      }
    }, 6000); // Check every 6 seconds
  }

  public async getCurrentBranch(): Promise<string | null> {
    const currentBranch = await this.getCurrentBranchInternal();
    if (currentBranch !== this.lastBranch) {
      this.lastBranch = currentBranch;
      Logger.log(`Branch changed to: ${currentBranch}`, "INFO");
    }
    return currentBranch;
  }

  private async getCurrentBranchInternal(): Promise<string | null> {
    if (!this.git) {
      return null;
    }
    try {
      return await this.git.revparse(["--abbrev-ref", "HEAD"]);
    } catch (error) {
      Logger.log(`Error getting current branch: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      return null;
    }
  }

  dispose() {
    if (this.pushCheckInterval) {
      clearInterval(this.pushCheckInterval);
    }
    if (this.branchPollingInterval) {
      clearInterval(this.branchPollingInterval);
    }
  }

  private clearTagCache() {
    this.tagCache = {tags: null, timestamp: 0};
    Logger.log("Tag cache cleared", "INFO");
  }

  private clearCaches() {
    this.defaultBranchCache.clear();
    this.cachedCIType = null;
    this.remoteUrlCache = {};
    this.ownerRepoCache = {};
    this.tagCache = {tags: null, timestamp: 0};
    this.commitCountCache = {};
    this.lastTagFetchRepo = null;
    this.lastBranch = null;
    Logger.log("All caches cleared", "INFO");
  }

  private async watchGitChanges() {
    if (!this.activeRepository) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.activeRepository, ".git/refs/remotes/origin/**")
    );

    watcher.onDidChange(() => this.debouncedHandleGitChange());

    this.context.subscriptions.push(watcher);
  }

  private async handleGitChange() {
    const currentBranch = await this.getCurrentBranch();
    if (!currentBranch) {
      return;
    }

    const localCommit = await this.git?.revparse([currentBranch]);
    const remoteCommit = await this.git?.revparse([`origin/${currentBranch}`]);

    if (localCommit === remoteCommit) {
      Logger.log("Git push detected", "INFO");
      setTimeout(() => {
        this._onGitPush.fire();
      }, 5000); // 5 second delay
    }
  }
}
