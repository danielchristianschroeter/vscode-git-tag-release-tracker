import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from 'vscode';
import { Logger } from '../utils/logger';
import simpleGit, { SimpleGit } from "simple-git";
import { debounce } from '../utils/debounce';

export interface TagResult {
  all: string[];
  latest: string | null;
}

export class GitService {
  private git: SimpleGit | null = null;
  private activeRepository: string | null = null;
  private currentBranch: string | null = null;
  private initialized: boolean = false;
  private _onRepoChanged = new EventEmitter<{ oldRepo: string | null, newRepo: string, oldBranch: string | null, newBranch: string | null }>();
  readonly onRepoChanged = this._onRepoChanged.event;
  private _onBranchChanged = new EventEmitter<{ oldBranch: string | null, newBranch: string | null }>();
  readonly onBranchChanged = this._onBranchChanged.event;
  private _onGitPush = new vscode.EventEmitter<void>();
  readonly onGitPush = this._onGitPush.event;
  private defaultBranchCache: Map<string, string> = new Map();
  private cachedCIType: 'github' | 'gitlab' | null = null;
  private remoteUrlCache: { [key: string]: string } = {};
  private ownerRepoCache: { [key: string]: { owner: string, repo: string } } = {};
  private tagCache: { tags: TagResult | null, timestamp: number } = { tags: null, timestamp: 0 };
  private readonly tagCacheDuration = 60000; // 1 minute
  private pushCheckInterval: NodeJS.Timeout | null = null;
  private branchPollingInterval: NodeJS.Timeout | null = null;
  private commitCountCache: { [key: string]: { count: number, timestamp: number } } = {};
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
    if (editor) {
      const filePath = editor.document.uri.fsPath;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (workspaceFolder) {
        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
          const newRepo = workspaceFolder.uri.fsPath;
          if (newRepo !== this.activeRepository) {
            const oldRepo = this.activeRepository;
            this.activeRepository = newRepo;
            this.git = simpleGit(this.activeRepository);
            this.initialized = false;
            await this.initialize();
            Logger.log(`Active repository changed to: ${this.activeRepository}`, 'INFO');
            
            // Clear caches when repository changes
            this.clearCaches();
            
            // Emit repository change event
            const oldBranch = this.currentBranch;
            this.currentBranch = await this.getCurrentBranchInternal();
            this._onRepoChanged.fire({ oldRepo, newRepo, oldBranch, newBranch: this.currentBranch });
          }
        }
      }
    }
  }

  public async initialize(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    if (!this.activeRepository) {
      Logger.log("No active repository", 'WARNING');
      return false;
    }

    try {
      const currentRepo = await this.getCurrentRepo();
      if (currentRepo !== this.lastRepo) {
        this.lastRepo = currentRepo;
        this.clearTagCache();
        Logger.log(`Repository changed to: ${currentRepo}. Tag cache cleared.`, 'INFO');
      }

      await this.git?.status();
      this.initialized = true;
      this.currentBranch = await this.getCurrentBranchInternal();
      Logger.log(`Git initialized successfully for ${this.activeRepository}. Current branch: ${this.currentBranch}`, 'INFO');
      await this.watchGitChanges();
      return true;
    } catch (error) {
      Logger.log(`Failed to initialize Git: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      return false;
    }
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  async createTagInternal(tag: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }

    try {
      Logger.log(`Creating tag ${tag} locally...`, 'INFO');
      await this.git.addAnnotatedTag(tag, `Release ${tag}`);
      Logger.log(`Tag ${tag} created locally`, 'INFO');
      
      // Force update of the local tag list
      await this.git.tags(['--list']);
    } catch (error) {
      Logger.log(`Error creating tag ${tag}: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      throw error;
    }
  }

  public async fetchAndTags(forceRefresh: boolean = false): Promise<TagResult | null> {
    const currentRepo = await this.getCurrentRepo();
    
    if (currentRepo !== this.lastTagFetchRepo) {
      this.lastTagFetchRepo = currentRepo;
      forceRefresh = true; // Force refresh when repo changes
    }

    const now = Date.now();
    if (!forceRefresh && this.tagCache.tags && now - this.tagCache.timestamp < this.tagCacheDuration) {
      Logger.log('Returning cached tags', 'INFO');
      return this.tagCache.tags;
    }

    try {
      if (!this.git) {
        throw new Error("Git is not initialized");
      }

      Logger.log('Fetching last 2 tags from remote...', 'INFO');
      await this.git.fetch(['--tags', '--prune', '--prune-tags']);

      const recentTags = await this.git.raw(['for-each-ref', '--sort=-creatordate', '--format=%(objectname)', '--count=2', 'refs/tags']);
      const tagList = recentTags.split('\n').filter(Boolean);
      const tags = await Promise.all(tagList.map(hash => this.git!.raw(['describe', '--tags', '--abbrev=0', hash]).catch(() => null)));

      const result: TagResult = {
        all: tags.filter(Boolean).map(tag => tag!.trim()),
        latest: tags[0]?.trim() || null
      };

      this.tagCache = { tags: result, timestamp: now };
      Logger.log(`Tags fetched and cached: ${JSON.stringify(result)}`, 'INFO');
      return result;
    } catch (error) {
      Logger.log(`Error fetching tags: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      return null;
    }
  }

  public async getCommitCounts(from: string | null, to: string): Promise<number> {
    try {
      if (!this.git) {
        throw new Error("Git is not initialized");
      }

      const cacheKey = `${from}-${to}`;
      const now = Date.now();

      // Fetch the latest changes
      await this.git.fetch(['--all', '--prune', '--tags']);

      // Check if both 'from' and 'to' branches/refs exist remotely
      const fromExists = from ? await this.remoteRefExists(from) : true;
      const toExists = await this.remoteRefExists(to);

      Logger.log(`Checking ref existence - from: ${from} (${fromExists}), to: ${to} (${toExists})`, 'INFO');

      // If either branch doesn't exist remotely, invalidate the cache and return 0
      if (!fromExists || !toExists) {
        Logger.log(`Remote branch or ref does not exist: ${!fromExists ? from : to}`, 'INFO');
        delete this.commitCountCache[cacheKey]; // Invalidate the cache
        return 0;
      }

      // Only check cache if both refs exist
      if (this.commitCountCache[cacheKey] && now - this.commitCountCache[cacheKey].timestamp < this.commitCountCacheDuration) {
        Logger.log(`Returning cached commit count for ${from} to ${to}`, 'INFO');
        return this.commitCountCache[cacheKey].count;
      }

      let result: string;
      if (from) {
        result = await this.git.raw(['rev-list', '--count', `${from}..${to}`]);
      } else {
        result = await this.git.raw(['rev-list', '--count', `${to}`]);
      }

      const count = parseInt(result.trim(), 10);
      Logger.log(`Commit count from ${from || 'beginning'} to ${to}: ${count}`, 'INFO');
      
      // Cache the result
      this.commitCountCache[cacheKey] = { count, timestamp: now };

      return count;
    } catch (error) {
      Logger.log(`Error getting commit count: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      return 0;
    }
  }

  private async remoteRefExists(ref: string): Promise<boolean> {
    try {
      const result = await this.git?.raw(['ls-remote', '--exit-code', '--heads', '--tags', 'origin', ref]);
      const exists = result !== '';
      Logger.log(`Checking if ref '${ref}' exists remotely: ${exists}`, 'INFO');
      return exists;
    } catch (error) {
      Logger.log(`Error checking if ref '${ref}' exists remotely: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      return false;
    }
  }

  public async getCurrentRepo(): Promise<string | null> {
    const currentRepo = this.activeRepository;
    if (currentRepo !== this.lastRepo) {
      this.lastRepo = currentRepo;
      this.clearTagCache();
      Logger.log(`Repository changed to: ${currentRepo}. Tag cache cleared.`, 'INFO');
    }
    return currentRepo;
  }

  public async getRemotes() {
    if (!this.git) {
      return [];
    }
    const remotes = await this.git.getRemotes(true);
    const remote = remotes.find((r) => r.name === "origin");
    if (remote) {
      const remoteUrl = remote.refs.fetch.replace(".git", "");
      this.activeRepository = remoteUrl.split("/").pop() || "";
    }
    return remotes;
  }

  async pushTag(tag: string): Promise<void> {
    if (!this.git) {
      throw new Error("Git is not initialized");
    }

    try {
      Logger.log(`Verifying tag ${tag} exists locally...`, 'INFO');
      const localTags = await this.git.tags();
      Logger.log(`Local tags: ${JSON.stringify(localTags)}`, 'INFO');

      if (!localTags.all.includes(tag)) {
        throw new Error(`Tag ${tag} does not exist locally`);
      }

      const tagCommit = await this.git.raw(['rev-list', '-n', '1', tag]);
      Logger.log(`Tag ${tag} is associated with commit ${tagCommit.trim()}`, 'INFO');

      Logger.log(`Pushing tag ${tag} to origin...`, 'INFO');
      await this.git.push('origin', tag);
      Logger.log(`Tag ${tag} pushed successfully`, 'INFO');

      // Verify the tag was pushed
      await this.git.fetch('origin', '--tags');
      const remoteTags = await this.git.tags(['--list', `${tag}`]);
      Logger.log(`Remote tags: ${JSON.stringify(remoteTags)}`, 'INFO');
      
      if (!remoteTags.all.includes(tag)) {
        Logger.log(`Tag ${tag} not found in remote tags list. Waiting and retrying...`, 'WARNING');
        // Wait for 5 seconds and try again
        await new Promise(resolve => setTimeout(resolve, 5000));
        const retryRemoteTags = await this.git.tags(['--list', `${tag}`]);
        Logger.log(`Retry remote tags: ${JSON.stringify(retryRemoteTags)}`, 'INFO');
        
        if (!retryRemoteTags.all.includes(tag)) {
          throw new Error(`Failed to verify tag ${tag} on remote after retry`);
        }
      }

      Logger.log(`Tag ${tag} successfully pushed and verified on remote`, 'INFO');
    } catch (error) {
      Logger.log(`Error pushing tag ${tag}: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      if (error instanceof Error && error.stack) {
        Logger.log(`Error stack: ${error.stack}`, 'ERROR');
      }
      throw error;
    }
  }

  async getRemoteUrl(): Promise<string | undefined> {
    const cacheKey = this.activeRepository || '';
    if (this.remoteUrlCache[cacheKey]) {
      return this.remoteUrlCache[cacheKey];
    }

    if (!this.git) {
      Logger.log('Git is not initialized, ignoring', 'WARNING');
      return undefined;
    }

    try {
      const remotes = await this.git.getRemotes(true);
      Logger.log(`All remotes: ${JSON.stringify(remotes)}`);

      const originRemote = remotes.find(remote => remote.name === 'origin');
      if (originRemote) {
        Logger.log(`Origin remote URL: ${originRemote.refs.fetch}`);
        const remoteUrl = originRemote.refs.fetch;
        if (remoteUrl) {
          this.remoteUrlCache[cacheKey] = remoteUrl;
        }
        return remoteUrl;
      }

      Logger.log('No origin remote found, ignoring', 'WARNING');
      return undefined;
    } catch (error) {
      Logger.log(`Error getting remote URL: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      return undefined;
    }
  }

  async getOwnerAndRepo(): Promise<{ owner: string, repo: string } | undefined> {
    const remoteUrl = await this.getRemoteUrl();
    if (!remoteUrl) { 
      return undefined;
    }
    
    if (this.ownerRepoCache[remoteUrl]) {
      return this.ownerRepoCache[remoteUrl];
    }

    try {
      if (!this.git) {
        Logger.log('Git is not initialized, ignoring', 'WARNING');
        return undefined;
      }

      Logger.log(`Remote URL: ${remoteUrl}`);

      if (!remoteUrl) {
        Logger.log('No remote URL found, ignoring', 'WARNING');
        return undefined;
      }

      // Handle HTTPS URLs (with or without credentials) and SSH URLs
      const urlPattern = /(?:https?:\/\/(?:[^@]+@)?|git@)((?:[\w.-]+\.)+[\w.-]+)[:/](.+?)\/([^/]+?)(?:\.git)?$/i;
      const match = remoteUrl.match(urlPattern);

      if (match) {
        const [, domain, fullPath, repo] = match;
        
        // Split the full path into parts
        const pathParts = fullPath.split('/');
        
        // The repo name is the last part, and everything else is the owner/group path
        const owner = pathParts.join('/');

        Logger.log(`Extracted owner and repo: ${owner}/${repo} (domain: ${domain})`);
        if (owner && repo) {
          this.ownerRepoCache[remoteUrl] = { owner, repo };
        }
        return { owner, repo };
      }

      Logger.log(`Unable to extract owner and repo from remote URL: ${remoteUrl}`, 'ERROR');
      return undefined;
    } catch (error) {
      Logger.log(`Error getting owner and repo: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      return undefined;
    }
  }

  public async hasCIConfiguration(): Promise<'github' | 'gitlab' | null> {
    if (!this.activeRepository) {
      return null;
    }

    const githubWorkflowsPath = path.join(this.activeRepository, '.github', 'workflows');
    const gitlabCIPath = path.join(this.activeRepository, '.gitlab-ci.yml');

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
    if (this.cachedCIType !== null) {
      return this.cachedCIType;
    }

    if (!this.activeRepository) {
      return null;
    }

    const githubWorkflowsPath = path.join(this.activeRepository, '.github', 'workflows');
    const gitlabCIPath = path.join(this.activeRepository, '.gitlab-ci.yml');

    if (fs.existsSync(githubWorkflowsPath) && fs.statSync(githubWorkflowsPath).isDirectory()) {
      this.cachedCIType = 'github';
    } else if (fs.existsSync(gitlabCIPath) && fs.statSync(gitlabCIPath).isFile()) {
      this.cachedCIType = 'gitlab';
    } else {
      this.cachedCIType = null;
    }

    return this.cachedCIType;
  }

  async pushChanges(branch: string): Promise<void> {
    await this.git?.push('origin', branch);
  }

  public async getDefaultBranch(): Promise<string | null> {
    if (!this.git) {
      Logger.log("Git is not initialized", 'INFO');
      return null;
    }

    const currentRepo = await this.getCurrentRepo();
    if (!currentRepo) {
      Logger.log("Current repository not detected", 'INFO');
      return null;
    }

    // Check if the default branch is cached for the current repo
    const cachedDefaultBranch = this.defaultBranchCache.get(currentRepo);
    if (cachedDefaultBranch) {
      return cachedDefaultBranch;
    }

    try {
      // First, try to get the default branch from the origin remote
      const result = await this.git.raw(['remote', 'show', 'origin']);
      const match = result.match(/HEAD branch: (.+)/);
      if (match) {
        const defaultBranch = match[1].trim();
        this.defaultBranchCache.set(currentRepo, defaultBranch);
        return defaultBranch;
      }

      // If that fails, fall back to checking common default branch names
      const commonDefaultBranches = ['main', 'master', 'develop'];
      for (const branch of commonDefaultBranches) {
        try {
          await this.git.raw(['rev-parse', '--verify', `origin/${branch}`]);
          this.defaultBranchCache.set(currentRepo, branch);
          return branch;
        } catch (error) {
          // Branch doesn't exist, continue to the next one
        }
      }

      // If all else fails, return the current branch as a default
      const currentBranch = await this.getCurrentBranchInternal();
      if (currentBranch) {
        Logger.log(`Unable to determine default branch, falling back to current branch "${currentBranch}"`, 'WARNING');
        this.defaultBranchCache.set(currentRepo, currentBranch);
        return currentBranch;
      } else {
        Logger.log("Unable to determine current branch", 'ERROR');
        return null;
      }
    } catch (error) {
      Logger.log(`Error getting default branch: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
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
      const result = await this.git.raw(['rev-list', '--max-parents=0', 'HEAD']);
      return result.trim();
    } catch (error) {
      Logger.log(`Error getting initial commit: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
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
        this._onBranchChanged.fire({ oldBranch, newBranch });
      }
    }, 6000); // Check every 6 seconds
  }

  public async getCurrentBranch(): Promise<string | null> {
    const currentBranch = await this.getCurrentBranchInternal();
    if (currentBranch !== this.lastBranch) {
      this.lastBranch = currentBranch;
      Logger.log(`Branch changed to: ${currentBranch}`, 'INFO');
    }
    return currentBranch;
  }

  private async getCurrentBranchInternal(): Promise<string | null> {
    if (!this.git) {
      return null;
    }
    try {
      return await this.git.revparse(['--abbrev-ref', 'HEAD']);
    } catch (error) {
      Logger.log(`Error getting current branch: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
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
    this.tagCache = { tags: null, timestamp: 0 };
  }

  private clearCaches() {
    this.defaultBranchCache.clear();
    this.cachedCIType = null;
    this.remoteUrlCache = {};
    this.ownerRepoCache = {};
    this.tagCache = { tags: null, timestamp: 0 };
    this.commitCountCache = {};
    this.lastTagFetchRepo = null;
    this.lastRepo = null;
    this.lastBranch = null;
  }

  private async watchGitChanges() {
    if (!this.activeRepository) {return;}

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.activeRepository, '.git/refs/remotes/origin/**')
    );

    watcher.onDidChange(() => this.debouncedHandleGitChange());

    this.context.subscriptions.push(watcher);
  }

  private async handleGitChange() {
    const currentBranch = await this.getCurrentBranch();
    if (!currentBranch) {return;}

    const localCommit = await this.git?.revparse([currentBranch]);
    const remoteCommit = await this.git?.revparse([`origin/${currentBranch}`]);

    if (localCommit === remoteCommit) {
      Logger.log('Git push detected', 'INFO');
      this._onGitPush.fire();
    }
  }
}