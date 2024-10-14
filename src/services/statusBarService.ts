import * as vscode from "vscode";
import { GitService, TagResult } from './gitService';
import { CIService } from './ciService';
import { Logger } from '../utils/logger';
import semver from 'semver';
import { debounce } from '../utils/debounce';

export class StatusBarService {
  private statusBarItem: vscode.StatusBarItem;
  private branchBuildStatusItem: vscode.StatusBarItem;
  private tagBuildStatusItem: vscode.StatusBarItem;
  private buttons: vscode.StatusBarItem[];
  private lastErrorTime: number = 0;
  private errorCooldownPeriod: number = 5 * 60 * 1000; // 5 minutes
  private _onCIStatusUpdate = new vscode.EventEmitter<{ status: string, url: string, isTag: boolean }>();
  readonly onCIStatusUpdate = this._onCIStatusUpdate.event;
  private branchBuildStatusUrl: string | undefined;
  private tagBuildStatusUrl: string | undefined;
  private compareUrl: string | undefined;
  private lastUpdateTime: number = 0;
  private updateCooldown: number = 20000; // 20 seconds cooldown
  private isUpdating: boolean = false;
  private debouncedUpdateEverything: (forceRefresh: boolean) => void;
  private inProgressRefreshIntervals: { [key: string]: NodeJS.Timeout } = {};
  private lastKnownStatuses: { [key: string]: string } = {};
  private lastUpdateRepo: string | null = null;
  private lastUpdateBranch: string | null = null;
  private debouncedRefreshAfterPush: () => void;

  constructor(
    private readonly commandIds: string[],
    private readonly context: vscode.ExtensionContext,
    private readonly gitService: GitService,
    private readonly ciService: CIService
  ) {
    this.statusBarItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.branchBuildStatusItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.tagBuildStatusItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.buttons = this.createButtons();
    this.gitService.onRepoChanged(this.handleRepoChange.bind(this));
    this.gitService.onBranchChanged(this.handleBranchChange.bind(this));
    vscode.window.onDidChangeActiveTextEditor(() => this.handleActiveEditorChange());
    this.debouncedUpdateEverything = debounce(this.updateEverything.bind(this), 500);
    this.debouncedRefreshAfterPush = debounce(this.refreshAfterPush.bind(this), 1000);
    this.gitService.onGitPush(() => this.debouncedRefreshAfterPush());

    Logger.log("StatusBarService constructor called", 'INFO');
    Logger.log(`Number of buttons created: ${this.buttons.length}`, 'INFO');

    // Add this line to trigger an initial update
    this.updateEverything(true);
  }

  private createStatusBarItem(alignment: vscode.StatusBarAlignment, priority: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(alignment, priority);
    this.context.subscriptions.push(item);
    return item;
  }

  private createButtons(): vscode.StatusBarItem[] {
    return this.commandIds.map((commandId, index) => {
      const priority = 96 - index;
      const button = this.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
      button.command = commandId;
      return button;
    });
  }

  public clearStatusBar() {
    this.statusBarItem.text = '';
    this.statusBarItem.tooltip = '';
    this.statusBarItem.command = undefined;
    this.statusBarItem.hide();
    this.branchBuildStatusItem.hide();
    this.buttons.forEach(button => button.hide());
  }

  public updateMainStatus(text: string, tooltip: string, command?: string) {
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.command = command;
    this.statusBarItem.show();
  }

  public async updateCIStatus(status: string, ref: string, url: string, isTag: boolean) {
    const statusItem = isTag ? this.tagBuildStatusItem : this.branchBuildStatusItem;
    const statusType = isTag ? 'Tag' : 'Branch';
    const config = vscode.workspace.getConfiguration('gitTagReleaseTracker');
    const ciProviders = config.get<{ [key: string]: { token: string, apiUrl: string } }>('ciProviders', {});

    // Get the owner and repo using GitService
    const ownerAndRepo = await this.gitService.getOwnerAndRepo();
    if (!ownerAndRepo) {
      Logger.log('Unable to determine owner and repo', 'WARNING');
      return;
    }
    const { owner, repo: repoName } = ownerAndRepo;

    let newText = '';
    let newTooltip = '';

    if (status === 'no_runs') {
      newText = `$(circle-slash) No ${statusType.toLowerCase()} builds found`;
      newTooltip = `No builds found for ${statusType.toLowerCase()} ${owner}/${repoName}/${ref}`;
    } else {
      const icon = this.getStatusIcon(status);
      newText = isTag 
        ? `${icon} ${statusType} build ${ref} ${status}`
        : `${icon} ${statusType} build ${status}`;
      newTooltip = `Click to open ${statusType.toLowerCase()} build status for ${owner}/${repoName}/${ref}`;
    }

    statusItem.text = newText;
    statusItem.tooltip = newTooltip;
    statusItem.command = isTag ? 'extension.openTagBuildStatus' : 'extension.openBranchBuildStatus';
    statusItem.show();

    if (isTag) {
      this.tagBuildStatusUrl = url;
    } else {
      this.branchBuildStatusUrl = url;
    }

    this._onCIStatusUpdate.fire({ status, url, isTag });

    if (status === 'error') {
      const ciType = this.gitService.detectCIType();
      if (ciType) {
        const defaultUrl = ciType === 'github' 
          ? `https://github.com/${owner}/${repoName}/actions`
          : `${ciProviders[ciType]?.apiUrl || `https://gitlab.com`}/${owner}/${repoName}/-/pipelines`;
        url = defaultUrl;

        const hasToken = ciProviders[ciType]?.token;
        const currentTime = Date.now();
        if (!hasToken && currentTime - this.lastErrorTime > this.errorCooldownPeriod) {
          vscode.window.showErrorMessage(`CI token for ${ciType} is not configured. Please set up your CI token in the extension settings.`);
          this.lastErrorTime = currentTime;
        } else if (hasToken && currentTime - this.lastErrorTime > this.errorCooldownPeriod) {
          vscode.window.showErrorMessage(`Error fetching ${statusType.toLowerCase()} build status. Please check your CI configuration and token.`);
          this.lastErrorTime = currentTime;
        }
      }
      Logger.log(`Error fetching ${statusType.toLowerCase()} build status for ${ref}`, 'ERROR');
    }
  }

  public clearTagBuildStatus() {
    this.tagBuildStatusItem.hide();
  }

  public updateButtonVisibility(showVersionButtons: boolean, showReleasedCommitsButton: boolean) {
    this.buttons.forEach((button, index) => {
      if (index < 4 && showVersionButtons) {
        button.show();
      } else if (index === 4 && showReleasedCommitsButton) {
        button.show();
      } else {
        button.hide();
      }
    });
  }

  private async updateVersionButtons() {
    const currentBranch = await this.gitService.getCurrentBranch();
    const defaultBranch = await this.gitService.getDefaultBranch();
    const isDefaultBranch = currentBranch === defaultBranch;
    const tags = await this.gitService.fetchAndTags();
    const unreleasedCount = await this.gitService.getCommitCounts(tags?.latest ?? null, currentBranch ?? '');

    // Hide all version buttons initially
    this.hideAllVersionButtons();

    if (isDefaultBranch && unreleasedCount > 0) {
      if (!tags || !tags.latest) {
        this.showInitialVersionButton();
      } else {
        this.showIncrementButtons(tags.latest);
      }
    }
  }

  private hideAllVersionButtons() {
    this.buttons.slice(0, 4).forEach(button => {
      button.hide();
    });
  }

  private showInitialVersionButton() {
    this.hideAllVersionButtons();
    this.updateButton(3, "1.0.0", "Create initial version tag 1.0.0");
    this.buttons[3].command = 'extension.createInitialTag';
    this.buttons[3].show();
  }

  private showIncrementButtons(latestTag: string) {
    const match = latestTag.match(/^([^\d]*)(\d+\.\d+\.\d+)(.*)$/);
    if (match) {
      const [, prefix, version, suffix] = match;
      ['major', 'minor', 'patch'].forEach((type, index) => {
        const newVersion = semver.inc(version, type as semver.ReleaseType);
        if (newVersion) {
          this.updateButton(
            index,
            `${newVersion}`,
            `Create and push ${type} tag version ${prefix}${newVersion}${suffix}`
          );
          this.buttons[index].command = `extension.create${type.charAt(0).toUpperCase() + type.slice(1)}Tag`;
          this.buttons[index].show();
        }
      });
    } else {
      Logger.log(`Invalid tag format: ${latestTag}`, 'WARNING');
    }
  }

  public async updateCommitCountButton(forceRefresh: boolean = false) {
    const [currentBranch, defaultBranch, ownerAndRepo, tags] = await Promise.all([
      this.gitService.getCurrentBranch(),
      this.gitService.getDefaultBranch(),
      this.gitService.getOwnerAndRepo(),
      this.gitService.fetchAndTags(forceRefresh)
    ]);

    if (!currentBranch || !defaultBranch || !ownerAndRepo) {
      Logger.log('Unable to update commit count button: missing branch or repo information', 'WARNING');
      return;
    }

    const { owner, repo } = ownerAndRepo;
    const isDefaultBranch = currentBranch === defaultBranch;

    let unreleasedCount = 0;
    let unmergedCount = 0;

    if (isDefaultBranch && tags && tags.latest) {
      unreleasedCount = await this.gitService.getCommitCounts(tags.latest, defaultBranch);
    } else if (!isDefaultBranch) {
      unmergedCount = await this.gitService.getCommitCounts(defaultBranch, currentBranch);
      if (tags && tags.latest) {
        unreleasedCount = await this.gitService.getCommitCounts(tags.latest, defaultBranch);
      }
    }

    let buttonText = '';
    let tooltipText = '';

    if (isDefaultBranch) {
      if (!tags || tags.all.length === 0) {
        const totalCommits = await this.gitService.getCommitCounts(null, currentBranch);
        buttonText = `${totalCommits} unreleased commits`;
        tooltipText = `${totalCommits} unreleased commits in ${owner}/${repo}/${currentBranch}\nClick to open compare view for all commits`;
      } else {
        buttonText = `${unreleasedCount} unreleased commits`;
        tooltipText = `${unreleasedCount} unreleased commits in ${owner}/${repo}/${currentBranch} since tag ${tags.latest}\nClick to open compare view for unreleased commits`;
      }
    } else {
      if (unmergedCount > 0) {
        buttonText = `${unmergedCount} unmerged commits`;
        tooltipText = `${unmergedCount} unmerged commits in ${owner}/${repo}/${currentBranch} compared to ${defaultBranch}`;
      } else {
        buttonText = `No unmerged commits`;
        tooltipText = `All commits in ${owner}/${repo}/${currentBranch} are merged to ${defaultBranch}`;
      }

      if (unreleasedCount > 0) {
        buttonText += `, ${unreleasedCount} unreleased`;
        tooltipText += `\n${unreleasedCount} unreleased commits on ${owner}/${repo}/${defaultBranch} since tag ${tags?.latest}`;
      }

      tooltipText += `\nClick to open compare view`;
    }

    const buttonIndex = 4; // Adjust this index if needed
    Logger.log(`Commit count button updated: ${buttonText}`, 'INFO');
    this.updateButton(buttonIndex, buttonText, tooltipText);
    this.buttons[buttonIndex].command = 'extension.openCompareLink';
    this.buttons[buttonIndex].show();
  }

  private updateButton(index: number, text: string, tooltip: string) {
    if (index >= 0 && index < this.buttons.length) {
      const button = this.buttons[index];
      button.text = text;
      button.tooltip = tooltip;
      button.show();
    }
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'success':
      case 'completed':
        return '$(check)';
      case 'failure':
      case 'failed':
        return '$(x)';
      case 'cancelled':
      case 'canceled':
        return '$(circle-slash)';
      case 'action_required':
      case 'manual':
        return '$(alert)';
      case 'in_progress':
      case 'running':
        return '$(sync~spin)';
      case 'queued':
      case 'created':
      case 'scheduled':
        return '$(clock)';
      case 'requested':
      case 'waiting':
      case 'waiting_for_resource':
        return '$(watch)';
      case 'pending':
      case 'preparing':
        return '$(clock)';
      case 'neutral':
        return '$(dash)';
      case 'skipped':
        return '$(skip)';
      case 'stale':
        return '$(history)';
      case 'timed_out':
        return '$(clock)';
      default:
        return '$(question)';
    }
  }

  public async reloadEverything(forceRefresh: boolean = true) {
    this.clearAllItems();
    await this.updateEverything(forceRefresh);
  }

  public async updateEverything(forceRefresh: boolean = false): Promise<void> {
    const now = Date.now();
    const currentRepo = await this.gitService.getCurrentRepo();
    const currentBranch = await this.gitService.getCurrentBranch();

    if (!forceRefresh && 
        now - this.lastUpdateTime < this.updateCooldown &&
        currentRepo === this.lastUpdateRepo &&
        currentBranch === this.lastUpdateBranch) {
      Logger.log("Update skipped due to cooldown or no change in repo/branch", 'INFO');
      return;
    }

    if (this.isUpdating) {
      Logger.log("Update already in progress, skipping", 'INFO');
      return;
    }
    this.isUpdating = true;

    try {
      if (!this.gitService.isInitialized()) {
        Logger.log("GitService not initialized, attempting to initialize...", 'INFO');
        const initialized = await this.gitService.initialize();
        if (!initialized) {
          Logger.log("Failed to initialize GitService, skipping update", 'ERROR');
          return;
        }
      }

      const [defaultBranch, ownerAndRepo, ciType] = await Promise.all([
        this.gitService.getDefaultBranch(),
        this.gitService.getOwnerAndRepo(),
        this.gitService.detectCIType()
      ]);

      Logger.log(`Current repo: ${currentRepo}, Current branch: ${currentBranch}, Owner/Repo: ${JSON.stringify(ownerAndRepo)}, CI Type: ${ciType}`, 'INFO');

      if (currentBranch && ownerAndRepo && ciType) {
        const { owner, repo } = ownerAndRepo;
        const isDefaultBranch = currentBranch === defaultBranch;

        Logger.log(`Current branch: ${currentBranch}, Default branch: ${defaultBranch}`, 'INFO');
        Logger.log(`Is default branch: ${isDefaultBranch}`, 'INFO');

        // Update version buttons first
        if (isDefaultBranch) {
          await this.updateVersionButtons();
        } else {
          this.hideAllVersionButtons();
        }

        // Then update other elements
        await Promise.all([
          this.updateCommitCountButton(forceRefresh),
          this.updateBranchBuildStatus(currentBranch, owner, repo, ciType, forceRefresh),
          isDefaultBranch ? this.updateTagBuildStatus(owner, repo, ciType, forceRefresh) : Promise.resolve(),
          this.updateCompareUrl()
        ]);
      } else {
        Logger.log("Missing required information, clearing status bar items", 'WARNING');
        this.clearAllItems();
      }

      this.lastUpdateTime = now;
      this.lastUpdateRepo = currentRepo;
      this.lastUpdateBranch = currentBranch;
      Logger.log("Status bar updated successfully", 'INFO');
    } catch (error) {
      Logger.log(`Error updating status bar: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      if (error instanceof Error && error.stack) {
        Logger.log(`Error stack: ${error.stack}`, 'ERROR');
      }
    } finally {
      this.isUpdating = false;
    }
  }

  public clearBranchBuildStatus() {
    this.branchBuildStatusItem.hide();
  }

  public clearAllBuildStatus() {
    this.branchBuildStatusItem.hide();
    this.tagBuildStatusItem.hide();
  }

  public clearAllItems() {
    this.statusBarItem.hide();
    this.branchBuildStatusItem.hide();
    this.tagBuildStatusItem.hide();
    this.buttons.forEach(button => button.hide());
  }

  private async updateBranchBuildStatus(branch: string, owner: string, repo: string, ciType: 'github' | 'gitlab', forceRefresh: boolean = false) {
    try {
      const buildStatus = await this.ciService.getBuildStatus(branch, owner, repo, ciType, false, forceRefresh);
      if (buildStatus) {
        await this.updateCIStatus(buildStatus.status, branch, buildStatus.url, false);
        this.lastKnownStatuses[branch] = buildStatus.status;
        if (this.ciService.isInProgressStatus(buildStatus.status)) {
          this.startRefreshingBranch(branch);
        } else {
          this.stopRefreshingBranch(branch);
        }
      } else {
        this.clearBranchBuildStatus();
      }
    } catch (error) {
      Logger.log(`Error updating branch build status: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      this.clearBranchBuildStatus();
    }
  }

  private async updateTagBuildStatus(owner: string, repo: string, ciType: 'github' | 'gitlab', forceRefresh: boolean = false) {
    const tags = await this.gitService.fetchAndTags();
    const latestTag = tags?.latest;
    if (!latestTag) {
      this.clearTagBuildStatus();
      return;
    }

    try {
      const buildStatus = await this.ciService.getBuildStatus(latestTag, owner, repo, ciType, true, forceRefresh);
      if (buildStatus) {
        await this.updateCIStatus(buildStatus.status, latestTag, buildStatus.url, true);
      } else {
        this.clearTagBuildStatus();
      }
    } catch (error) {
      Logger.log(`Error updating tag build status: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      this.clearTagBuildStatus();
    }
  }

  private handleActiveEditorChange() {
    const initialized = this.gitService.isInitialized();
    if (initialized) {
      this.updateEverything(false);
    } else {
      this.clearAllItems();
    }
  }

  public getTagBuildStatusUrl(): string | undefined {
    return this.tagBuildStatusUrl;
  }

  public getBranchBuildStatusUrl(): string | undefined {
    return this.branchBuildStatusUrl;
  }

  public getCompareUrl(): string | undefined {
    return this.compareUrl;
  }

  private async updateCompareUrl(): Promise<void> {
    try {
      const [currentBranch, defaultBranch, ownerAndRepo] = await Promise.all([
        this.gitService.getCurrentBranch(),
        this.gitService.getDefaultBranch(),
        this.gitService.getOwnerAndRepo()
      ]);

      if (!currentBranch || !defaultBranch || !ownerAndRepo) {
        Logger.log('Missing required information for compare URL', 'WARNING');
        this.compareUrl = undefined;
        return;
      }

      const { owner, repo } = ownerAndRepo;
      const repoInfo = await this.getBaseUrl();
      if (!repoInfo) {
        Logger.log('Unable to determine base URL for repository', 'WARNING');
        this.compareUrl = undefined;
        return;
      }

      const { baseUrl, projectPath } = repoInfo;

      if (currentBranch !== defaultBranch) {
        this.compareUrl = `${baseUrl}/${projectPath}/compare/${defaultBranch}...${currentBranch}`;
      } else {
        const tags = await this.gitService.fetchAndTags(true); // Force refresh
        if (tags?.latest) {
          this.compareUrl = `${baseUrl}/${projectPath}/compare/${tags.latest}...${currentBranch}`;
        } else {
          const initialCommit = await this.gitService.getInitialCommit();
          this.compareUrl = `${baseUrl}/${projectPath}/compare/${initialCommit}...${currentBranch}`;
        }
      }
      Logger.log(`Compare URL updated: ${this.compareUrl}`, 'INFO');
    } catch (error) {
      Logger.log(`Error generating compare URL: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
      this.compareUrl = undefined;
    }
  }

  private async getBaseUrl(): Promise<{ baseUrl: string, projectPath: string } | null> {
    const remoteUrl = await this.gitService.getRemoteUrl();
    if (!remoteUrl) {
      Logger.log('No remote URL found', 'WARNING');
      return null;
    }
  
    let match;
    if (remoteUrl.startsWith('git@')) {
      // SSH URL
      match = remoteUrl.match(/git@([^:]+):(.+)\.git$/);
      if (match) {
        const [, domain, path] = match;
        return {
          baseUrl: `https://${domain}`,
          projectPath: path
        };
      }
    } else if (remoteUrl.startsWith('https://')) {
      // HTTPS URL
      match = remoteUrl.match(/https:\/\/([^/]+)\/(.+)\.git$/);
      if (match) {
        const [, domain, path] = match;
        return {
          baseUrl: `https://${domain}`,
          projectPath: path
        };
      }
    }
  
    Logger.log(`Unable to parse remote URL: ${remoteUrl}`, 'WARNING');
    return null;
  }
  
  private async handleRepoChange({ oldRepo, newRepo, oldBranch, newBranch }: { oldRepo: string | null, newRepo: string, oldBranch: string | null, newBranch: string | null }) {
    if (oldRepo === newRepo) {
      Logger.log(`Repository unchanged: ${newRepo}`, 'INFO');
      return;
    }

    Logger.log(`Repository changed from ${oldRepo} to ${newRepo}`, 'INFO');
    
    // Clear existing status
    this.clearAllItems();

    // Clear CI service cache
    this.ciService.clearCache();

    // Reset last update time to force a refresh
    this.lastUpdateTime = 0;

    // Force refresh tags
    await this.gitService.fetchAndTags(true);

    // Force refresh for the new repository
    await this.updateEverything(true);

    this.lastUpdateRepo = newRepo;

    // Handle branch change if it occurred during repo change
    if (oldBranch !== newBranch) {
      await this.handleBranchChange({ oldBranch, newBranch });
    }
  }

  private async handleBranchChange({ oldBranch, newBranch }: { oldBranch: string | null, newBranch: string | null }) {
    if (newBranch === null) {
      Logger.log('Unable to determine current branch', 'WARNING');
      this.clearAllItems();
      return;
    }

    Logger.log(`Branch changed from ${oldBranch} to ${newBranch}`, 'INFO');
    
    // Stop refreshing the previous branch if it's not in progress
    if (oldBranch && oldBranch !== newBranch) {
      const previousStatus = this.lastKnownStatuses[oldBranch];
      if (!this.ciService.isInProgressStatus(previousStatus)) {
        this.stopRefreshingBranch(oldBranch);
      }
    }

    // Clear existing status
    this.clearAllItems();

    // Force refresh for the new branch
    await this.updateEverything(true);

    // Start refreshing if the new branch is in progress
    const currentStatus = this.lastKnownStatuses[newBranch];
    if (this.ciService.isInProgressStatus(currentStatus)) {
      this.startRefreshingBranch(newBranch);
    }
  }

  private startRefreshingBranch(branch: string) {
    if (this.inProgressRefreshIntervals[branch]) {
      clearInterval(this.inProgressRefreshIntervals[branch]);
    }
    this.inProgressRefreshIntervals[branch] = setInterval(() => {
      this.refreshBranchStatus(branch);
    }, 6000); // Refresh every 6 seconds
  }

  private stopRefreshingBranch(branch: string) {
    if (this.inProgressRefreshIntervals[branch]) {
      clearInterval(this.inProgressRefreshIntervals[branch]);
      delete this.inProgressRefreshIntervals[branch];
    }
  }

  private async refreshBranchStatus(branch: string) {
    const ownerAndRepo = await this.gitService.getOwnerAndRepo();
    const ciType = this.gitService.detectCIType();
    if (ownerAndRepo && ciType) {
      const { owner, repo } = ownerAndRepo;
      const buildStatus = await this.ciService.getBuildStatus(branch, owner, repo, ciType, false, true);
      if (buildStatus) {
        await this.updateCIStatus(buildStatus.status, branch, buildStatus.url, false);
        this.lastKnownStatuses[branch] = buildStatus.status;
        if (!this.ciService.isInProgressStatus(buildStatus.status)) {
          this.stopRefreshingBranch(branch);
        }
      }
    }
  }

  private async refreshAfterPush() {
    Logger.log('Refreshing branch build status after push', 'INFO');
    const currentBranch = await this.gitService.getCurrentBranch();
    const ownerAndRepo = await this.gitService.getOwnerAndRepo();
    const ciType = this.gitService.detectCIType();

    if (currentBranch && ownerAndRepo && ciType) {
      const { owner, repo } = ownerAndRepo;
      await this.updateBranchBuildStatus(currentBranch, owner, repo, ciType, true);
      await this.updateCommitCountButton(true);
    }
  }

  public triggerUpdate(forceRefresh: boolean = false): void {
    this.debouncedUpdateEverything(forceRefresh);
  }
}