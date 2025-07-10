import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {EventEmitter} from "vscode";
import {Logger} from "../utils/logger";
import simpleGit, {SimpleGit, SimpleGitOptions} from "simple-git";
import {debounce} from "../utils/debounce";
import {globals} from "../globals";

export interface TagResult {
  latest: string | null;
}

export class GitService {
  private git: SimpleGit;
  private currentBranch: string | null = null;
  private initialized: boolean = false;
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
  private lastBranch: string | null = null;
  private context: vscode.ExtensionContext;
  private debouncedHandleGitChange: () => void;
  private repoRoot: string;

  constructor(context: vscode.ExtensionContext, repoRoot: string) {
    this.context = context;
    this.repoRoot = repoRoot;
    const options: Partial<SimpleGitOptions> = {
      baseDir: repoRoot,
      binary: "git",
      maxConcurrentProcesses: 6,
    };
    this.git = simpleGit(options);
    this.startBranchPolling();
    this.debouncedHandleGitChange = debounce(this.handleGitChange.bind(this), 500);
  }

  public async initialize(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    try {
      this.clearTagCache();
      Logger.log(`Repository changed to: ${this.repoRoot}. Tag cache cleared.`, "INFO");

      await this.git?.status();
      this.initialized = true;
      this.currentBranch = await this.getCurrentBranchInternal();
      Logger.log(
        `Git initialized successfully for ${this.repoRoot}. Current branch: ${this.currentBranch}`,
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
  public getRepositoryRoot(): string {
    return this.repoRoot;
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

  public async getLatestTag(forceRefresh: boolean = false): Promise<TagResult> {
    const currentRepo = this.repoRoot;
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

      try {
        Logger.log("Fetching latest tag from remote...", "INFO");
        await this.git.fetch(["--tags", "--prune", "--prune-tags"]);
      } catch (fetchError) {
        Logger.log(`Could not fetch from remote. Falling back to local tags. Error: ${fetchError}`, "WARNING");
      }

      // Get all tags and filter for semantic versions
      let latestTag: string | null = null;
      try {
        const tags = await this.git.tags();
        const semverRegex = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
        const semverTags = tags.all.filter(tag => semverRegex.test(tag))
          .sort((a, b) => {
            // Remove 'v' prefix if present for comparison
            const cleanA = a.replace(/^v/, '');
            const cleanB = b.replace(/^v/, '');
            return this.compareVersions(cleanB, cleanA); // Sort in descending order
          });
        
        latestTag = semverTags.length > 0 ? semverTags[0] : null;
      } catch (error) {
        // If no tags are found, this command will throw an error
        Logger.log("No semantic version tags found in the repository", "INFO");
      }

      const result: TagResult = {latest: latestTag};

      this.tagCache = {tags: result, timestamp: now};
      Logger.log(`Latest semantic version tag fetched and cached: ${JSON.stringify(result)}`, "INFO");
      return result;
    } catch (error) {
      Logger.log(`Error fetching tags: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      return {latest: null};
    }
  }

  private compareVersions(a: string, b: string): number {
    const partsA = a.split(/[.-]/);
    const partsB = b.split(/[.-]/);
    
    // Compare major.minor.patch
    for (let i = 0; i < 3; i++) {
      const numA = parseInt(partsA[i] || '0', 10);
      const numB = parseInt(partsB[i] || '0', 10);
      if (numA !== numB) {
        return numA - numB;
      }
    }
    
    // If versions are equal but one has pre-release/build metadata
    if (partsA.length !== partsB.length) {
      return partsB.length - partsA.length; // Prefer version without metadata
    }
    
    // If all parts are equal
    return 0;
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

      let command: string[];
      if (from) {
        // Use the ^from shorthand to exclude commits reachable from 'from'
        command = ["rev-list", "--count", to, `^${from}`];
      } else {
        // If from is null, count all commits up to 'to'
        command = ["rev-list", "--count", to];
      }
      Logger.log(`Executing git command: git ${command.join(" ")} in ${this.repoRoot}`, "INFO");

      const revList = await this.git.raw(command);
      const count = parseInt(revList.trim(), 10);
      this.commitCountCache[cacheKey] = {count, timestamp: now}; // Update cache
      Logger.log(`Commit count for ${from}..${to} is ${count}`, "INFO");
      return count;
    } catch (error) {
      Logger.log(`Error counting commits: ${error instanceof Error ? error.message : String(error)}`, "ERROR");
      throw error;
    }
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.raw(["show-ref", "--verify", `refs/tags/${ref}`]);
      return true;
    } catch (e) {
      try {
        await this.git.raw(["show-ref", "--verify", `refs/remotes/origin/${ref}`]);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  public async getCurrentRepo(): Promise<string> {
    return this.repoRoot;
  }

  public async getRemotes() {
    return this.git.getRemotes(true);
  }

  async pushTag(tag: string, timeout: number = 30000): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }

    try {
      Logger.log(`Pushing tag ${tag} to remote...`, "INFO");

      const pushPromise = this.git.push(["origin", tag]);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Push operation timed out")), timeout)
      );

      await Promise.race([pushPromise, timeoutPromise]);
      Logger.log(`Tag ${tag} pushed to remote`, "INFO");

      // Emit git push event
      this._onGitPush.fire();
    } catch (error) {
      Logger.log(`Error pushing tag ${tag}: ${error instanceof Error ? error.message : String(error)}`, "ERROR");
      throw error;
    }
  }

  async getRemoteUrl(): Promise<string | undefined> {
    const cacheKey = this.repoRoot;
    if (this.remoteUrlCache[cacheKey]) {
      return this.remoteUrlCache[cacheKey];
    }
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === "origin");
    if (origin) {
      const url = origin.refs.fetch;
      this.remoteUrlCache[cacheKey] = url;
      return url;
    }
    return undefined;
  }

  async getOwnerAndRepo(): Promise<{owner: string; repo: string} | undefined> {
    const cacheKey = this.repoRoot;
    if (this.ownerRepoCache[cacheKey]) {
      return this.ownerRepoCache[cacheKey];
    }

    try {
      const remoteUrl = await this.getRemoteUrl();
      if (!remoteUrl) {
        return undefined;
      }
      
      const cleanedUrl = remoteUrl.trim();
      let match;

      // Handle SSH URLs: git@hostname:owner/repo.git or git@hostname:group/subgroup/repo.git
      if (cleanedUrl.startsWith("git@")) {
        match = cleanedUrl.match(/git@[\w.-]+:((?:[\w.-]+\/)*[\w.-]+)\.git$/);
      } else {
        // Handle HTTPS URLs: https://hostname/owner/repo.git or https://hostname/group/subgroup/repo.git
        // allow optional credentials (user:token@) before the host
        match = cleanedUrl.match(/https?:\/\/(?:[^@\/]+@)?(?:www\.)?[\w.-]+\/((?:[\w.-]+\/)*[\w.-]+)\.git$/);
      }
      
      if (match && match[1]) {
        const parts = match[1].split('/');
        const repo = parts.pop();
        const owner = parts.join('/');
        if (owner && repo) {
            this.ownerRepoCache[cacheKey] = { owner, repo };
            return { owner, repo };
        }
      }

      Logger.log(`Unable to extract owner and repo from remote URL: ${cleanedUrl}`, "WARNING");
      return undefined;

    } catch (error) {
      Logger.log(`Error getting owner/repo: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
      return undefined;
    }
  }

  public async hasCIConfiguration(): Promise<"github" | "gitlab" | null> {
    if (this.cachedCIType) {
      return this.cachedCIType;
    }

    const githubWorkflowsPath = path.join(this.repoRoot, ".github", "workflows");
    const gitlabCIPath = path.join(this.repoRoot, ".gitlab-ci.yml");

    try {
      const githubExists = await fs.promises.stat(githubWorkflowsPath).then(
        (stat) => stat.isDirectory(),
        () => false
      );
      if (githubExists) {
        this.cachedCIType = "github";
        return "github";
      }

      const gitlabExists = await fs.promises.stat(gitlabCIPath).then(
        (stat) => stat.isFile(),
        () => false
      );
      if (gitlabExists) {
        this.cachedCIType = "gitlab";
        return "gitlab";
      }
    } catch (error) {
      // Handled by returning null
    }

    return null;
  }
  public detectCIType(): "github" | "gitlab" | null {
    if (this.cachedCIType) {
      return this.cachedCIType;
    }

    const githubWorkflowsPath = path.join(this.repoRoot, ".github", "workflows");
    const gitlabCIPath = path.join(this.repoRoot, ".gitlab-ci.yml");

    if (fs.existsSync(githubWorkflowsPath) && fs.statSync(githubWorkflowsPath).isDirectory()) {
      this.cachedCIType = "github";
      return "github";
    }

    if (fs.existsSync(gitlabCIPath) && fs.statSync(gitlabCIPath).isFile()) {
      this.cachedCIType = "gitlab";
      return "gitlab";
    }

    return null;
  }
  async pushChanges(branch: string): Promise<void> {
    await this.git.push("origin", branch);
    this._onGitPush.fire();
  }
  public async getDefaultBranch(): Promise<string | null> {
    Logger.log("Getting default branch...", "INFO");

    if (!this.git) {
      Logger.log("Git not initialized, cannot get default branch.", "WARNING");
      return null;
    }

    const cacheKey = this.repoRoot || "default";

    if (this.defaultBranchCache.has(cacheKey)) {
      const cachedBranch = this.defaultBranchCache.get(cacheKey);
      Logger.log(`Returning cached default branch: ${cachedBranch}`, "INFO");
      return cachedBranch || null;
    }

    try {
      Logger.log("Fetching remote head to determine default branch...", "INFO");
      // Fetch remote head and show the symbolic ref for origin/HEAD
      const remoteInfo = await this.git.remote(["show", "origin"]);
      if (typeof remoteInfo === "string") {
        const match = remoteInfo.match(/HEAD branch: (.*)/);
        if (match && match[1] && match[1] !== "(unknown)") {
          const defaultBranch = match[1];
          Logger.log(`Default branch is ${defaultBranch}`, "INFO");
          this.defaultBranchCache.set(cacheKey, defaultBranch);
          return defaultBranch;
        }
      }

      Logger.log("Could not determine default branch from remote. Trying other methods.", "WARNING");

      // Fallback for older Git versions
      const remotes = await this.git.branch(["-r"]);
      if (remotes.all.includes("origin/main")) {
        this.defaultBranchCache.set(cacheKey, "main");
        return "main";
      }
      if (remotes.all.includes("origin/master")) {
        this.defaultBranchCache.set(cacheKey, "master");
        return "master";
      }

      return null; // No default branch found
    } catch (error) {
      Logger.log(
        `Error getting default branch: ${error instanceof Error ? error.message : String(error)}`,
        "WARNING"
      );
      return null;
    }
  }

  public async waitForInitialization(timeout = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.git && this.repoRoot) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  public async getInitialCommit(): Promise<string | null> {
    try {
      // --reverse puts the first commit first
      const log = await this.git.raw(["rev-list", "--max-parents=0", "HEAD"]);
      return log.trim() || null;
    } catch (e) {
      Logger.log(`Error getting initial commit: ${e}`, "ERROR");
      return null;
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
    }, 5000); // Poll every 5 seconds
  }

  public async getCurrentBranch(): Promise<string | null> {
    if (!this.git) {
      return null;
    }
    if (!this.currentBranch) {
      this.currentBranch = await this.getCurrentBranchInternal();
    }
    return this.currentBranch;
  }

  private async getCurrentBranchInternal(): Promise<string | null> {
    if (!this.git) {
      return null;
    }
    const status = await this.git.status();
    return status.current;
  }

  dispose() {
    if (this.pushCheckInterval) {
      clearInterval(this.pushCheckInterval);
    }
    if (this.branchPollingInterval) {
      clearInterval(this.branchPollingInterval);
    }
    this._onGitPush.dispose();
    this._onBranchChanged.dispose();
  }

  private clearTagCache() {
    this.tagCache = {tags: null, timestamp: 0};
  }
  private clearCaches() {
    this.clearTagCache();
    this.commitCountCache = {};
    this.ownerRepoCache = {};
    this.remoteUrlCache = {};
    this.cachedCIType = null;
    this.defaultBranchCache.clear();
  }

  private async watchGitChanges() {
    if (!this.git) {
      return;
    }

    // Watch for changes in .git/HEAD to detect branch switches
    const headWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repoRoot, ".git/HEAD")
    );
    headWatcher.onDidChange(this.debouncedHandleGitChange);
    this.context.subscriptions.push(headWatcher);

    // Watch for changes in .git/refs/heads/** to detect new commits
    const headsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repoRoot, ".git/refs/heads/**")
    );
    headsWatcher.onDidChange(this.debouncedHandleGitChange);
    this.context.subscriptions.push(headsWatcher);

    // Watch for changes in .git/refs/tags/** to detect new tags
    const tagsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repoRoot, ".git/refs/tags/**")
    );
    tagsWatcher.onDidChange(this.debouncedHandleGitChange);
    this.context.subscriptions.push(tagsWatcher);

    // Watch for push events by monitoring remote refs
    const remoteRefWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repoRoot, ".git/refs/remotes/origin/**")
    );
    remoteRefWatcher.onDidChange(() => this._onGitPush.fire());
    this.context.subscriptions.push(remoteRefWatcher);
  }

  private async handleGitChange() {
    Logger.log("Detected change in .git directory, re-evaluating state.", "INFO");
    const newBranch = await this.getCurrentBranchInternal();
    if (newBranch !== this.currentBranch) {
      const oldBranch = this.currentBranch;
      this.currentBranch = newBranch;
      Logger.log(`Branch changed from ${oldBranch} to ${newBranch}`, "INFO");
      this._onBranchChanged.fire({oldBranch, newBranch});
    }

    // Force a refresh of tags and other data
    this.clearCaches();

    // Notify the dashboard (via MultiRepoService) that the repository state
    // has changed so that unreleased / unmerged commit counts refresh
    // automatically after a commit.
    globals.statusBarService?.getMultiRepoService()?.invalidateCacheForRepo(this.repoRoot);
  }

  private async isGitRepository(repoPath: string): Promise<boolean> {
    try {
      const git = simpleGit(repoPath);
      await git.status();
      return true;
    } catch (error) {
      return false;
    }
  }

  public async hasRemote(): Promise<boolean> {
    try {
      const remotes = await this.git.getRemotes();
      return remotes.length > 0;
    } catch (error) {
      Logger.log(`Error checking for remotes: ${error}`, "WARNING");
      return false;
    }
  }

  public async fetchLatest(): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }
    await this.git.fetch();
  }
  
  public async getBaseUrl(): Promise<string | undefined> {
    const remoteUrl = await this.getRemoteUrl();
    if (!remoteUrl) {
      return undefined;
    }

    // Handle SSH URLs
    let match = remoteUrl.match(/git@([^:]+):/);
    if (match) {
      return `https://${match[1]}`;
    }

    // Handle HTTPS URLs
    match = remoteUrl.match(/https:\/\/([^\/]+)/);
    if (match) {
      return match[0];
    }
    
    return undefined;
  }

  public getRepoRoot(): string {
    return this.repoRoot;
  }
}
