import * as vscode from "vscode";
import {GitService, TagResult} from "./gitService";
import {CIService} from "./ciService";
import {Logger} from "../utils/logger";
import semver from "semver";
import {debounce} from "../utils/debounce";

export class StatusBarService {
  private branchBuildStatusItem: vscode.StatusBarItem;
  private tagBuildStatusItem: vscode.StatusBarItem;
  private buttons: vscode.StatusBarItem[];
  private lastErrorTime: number = 0;
  private errorCooldownPeriod: number = 5 * 60 * 1000; // 5 minutes
  private _onCIStatusUpdate = new vscode.EventEmitter<{status: string; url: string; isTag: boolean}>();
  readonly onCIStatusUpdate = this._onCIStatusUpdate.event;
  private branchBuildStatusUrl: string | undefined;
  private tagBuildStatusUrl: string | undefined;
  private compareUrl: string | undefined;
  private debouncedUpdateEverything = debounce(async (forceRefresh: boolean = false) => {
    await this.updateEverything(forceRefresh);
  }, 2000);
  private inProgressRefreshIntervals: {[key: string]: NodeJS.Timeout} = {};
  private lastKnownStatuses: {[key: string]: string} = {};
  private debouncedRefreshAfterPush: () => void;
  private debouncedHandleActiveEditorChange = debounce(() => this.handleActiveEditorChange(), 300);
  private cachedData: {
    currentBranch: string | null;
    defaultBranch: string | null;
    latestTag: TagResult | null;
    unreleasedCount: number | null;
    ownerAndRepo: {owner: string; repo: string} | null;
  } = {
    currentBranch: null,
    defaultBranch: null,
    latestTag: null,
    unreleasedCount: null,
    ownerAndRepo: null
  };

  constructor(
    private readonly commandIds: string[],
    private readonly context: vscode.ExtensionContext,
    private readonly gitService: GitService,
    private readonly ciService: CIService
  ) {
    this.branchBuildStatusItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.tagBuildStatusItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.buttons = this.createButtons();
    this.gitService.onRepoChanged(this.handleRepoChange.bind(this));
    this.gitService.onBranchChanged(this.handleBranchChange.bind(this));
    vscode.window.onDidChangeActiveTextEditor(() => this.handleActiveEditorChange());
    this.debouncedUpdateEverything = debounce(this.updateEverything.bind(this), 5000);
    this.debouncedRefreshAfterPush = debounce(this.refreshAfterPush.bind(this), 5000);
    this.gitService.onGitPush(() => this.debouncedRefreshAfterPush());
    vscode.window.onDidChangeActiveTextEditor(() => this.debouncedHandleActiveEditorChange());

    Logger.log("StatusBarService constructor called", "INFO");
    Logger.log(`Number of buttons created: ${this.buttons.length}`, "INFO");

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
    this.branchBuildStatusItem.hide();
    this.buttons.forEach(button => button.hide());
  }

  public async updateCIStatus(status: string, ref: string, url: string, isTag: boolean) {
    const statusItem = isTag ? this.tagBuildStatusItem : this.branchBuildStatusItem;
    const statusType = isTag ? "Tag" : "Branch";
    const config = vscode.workspace.getConfiguration("gitTagReleaseTracker");
    const ciProviders = config.get<{[key: string]: {token: string; apiUrl: string}}>("ciProviders", {});

    // Get the owner and repo using GitService
    const ownerAndRepo = await this.gitService.getOwnerAndRepo();
    if (!ownerAndRepo) {
      Logger.log("Unable to determine owner and repo", "WARNING");
      return;
    }
    const {owner, repo: repoName} = ownerAndRepo;

    let newText = "";
    let newTooltip = "";

    if (status === "no_runs") {
      newText = `$(circle-slash) No ${statusType.toLowerCase()} builds found`;
      newTooltip = `No builds found for ${statusType.toLowerCase()} ${owner}/${repoName}/${ref}`;
    } else {
      const icon = this.getStatusIcon(status);
      newText = isTag ? `${icon} ${statusType} build ${ref} ${status}` : `${icon} ${statusType} build ${status}`;
      newTooltip = `Click to open ${statusType.toLowerCase()} build status for ${owner}/${repoName}/${ref}`;
    }

    statusItem.text = newText;
    statusItem.tooltip = newTooltip;
    statusItem.command = isTag ? "extension.openTagBuildStatus" : "extension.openBranchBuildStatus";
    statusItem.show();

    if (isTag) {
      this.tagBuildStatusUrl = url;
    } else {
      this.branchBuildStatusUrl = url;
    }

    this._onCIStatusUpdate.fire({status, url, isTag});

    if (status === "error") {
      const ciType = this.gitService.detectCIType();
      if (ciType) {
        const defaultUrl =
          ciType === "github"
            ? `https://github.com/${owner}/${repoName}/actions`
            : `${ciProviders[ciType]?.apiUrl || `https://gitlab.com`}/${owner}/${repoName}/-/pipelines`;
        url = defaultUrl;

        const hasToken = ciProviders[ciType]?.token;
        const currentTime = Date.now();
        if (!hasToken && currentTime - this.lastErrorTime > this.errorCooldownPeriod) {
          vscode.window.showErrorMessage(
            `CI token for ${ciType} is not configured. Please set up your CI token in the extension settings.`
          );
          this.lastErrorTime = currentTime;
        } else if (hasToken && currentTime - this.lastErrorTime > this.errorCooldownPeriod) {
          vscode.window.showErrorMessage(
            `Error fetching ${statusType.toLowerCase()} build status. Please check your CI configuration and token.`
          );
          this.lastErrorTime = currentTime;
        }
      }
      Logger.log(`Error fetching ${statusType.toLowerCase()} build status for ${ref}`, "ERROR");
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
    if (
      !this.cachedData.currentBranch ||
      !this.cachedData.defaultBranch ||
      this.cachedData.unreleasedCount === null ||
      !this.cachedData.ownerAndRepo
    ) {
      Logger.log(
        `Missing data: currentBranch=${!!this.cachedData.currentBranch}, defaultBranch=${!!this.cachedData
          .defaultBranch}, unreleasedCount=${this.cachedData.unreleasedCount}, ownerAndRepo=${!!this.cachedData
          .ownerAndRepo}`,
        "INFO"
      );
      return;
    }

    const cleanCurrentBranch = (this.cachedData.currentBranch || "").replace(/^origin\//, "");
    const cleanDefaultBranch = (this.cachedData.defaultBranch || "").replace(/^origin\//, "");
    const isDefaultBranch = cleanCurrentBranch === cleanDefaultBranch;
    const {owner, repo} = this.cachedData.ownerAndRepo;

    Logger.log(
      `Current branch: ${this.cachedData.currentBranch}, Default branch: ${this.cachedData.defaultBranch}`,
      "INFO"
    );
    Logger.log(`Is default branch: ${isDefaultBranch}, Unreleased count: ${this.cachedData.unreleasedCount}`, "INFO");
    Logger.log(`Latest tag: ${this.cachedData.latestTag?.latest}`, "INFO");

    // Hide all version buttons initially
    this.hideAllVersionButtons();

    if (isDefaultBranch && this.cachedData.unreleasedCount > 0) {
      if (!this.cachedData.latestTag?.latest) {
        Logger.log("Showing initial version button", "INFO");
        this.showInitialVersionButton(owner, repo);
      } else {
        Logger.log("Showing increment buttons", "INFO");
        this.showIncrementButtons(this.cachedData.latestTag.latest, owner, repo);
      }
    } else {
      Logger.log(
        `Not showing version buttons. isDefaultBranch=${isDefaultBranch}, unreleasedCount=${this.cachedData.unreleasedCount}`,
        "INFO"
      );
    }

    Logger.log(
      `Version buttons updated. Is default branch: ${isDefaultBranch}, Latest tag: ${this.cachedData.latestTag?.latest}, Unreleased count: ${this.cachedData.unreleasedCount}`,
      "INFO"
    );
  }

  public hideAllVersionButtons() {
    this.buttons.slice(0, 4).forEach(button => {
      button.hide();
    });
  }

  private showInitialVersionButton(owner: string, repo: string) {
    Logger.log(`Attempting to show initial version button for ${owner}/${repo}`, "INFO");
    this.updateButton(3, "1.0.0", `Create initial version tag 1.0.0 for ${owner}/${repo}`);
    this.buttons[3].command = "extension.createInitialTag";
    this.buttons[3].show();
    Logger.log("Initial version button should now be visible", "INFO");
  }

  private showIncrementButtons(latestTag: string, owner: string, repo: string) {
    const match = latestTag.match(/^([^\d]*)(\d+\.\d+\.\d+)(.*)$/);
    if (match) {
      const [, prefix, version, suffix] = match;
      ["major", "minor", "patch"].forEach((type, index) => {
        const newVersion = semver.inc(version, type as semver.ReleaseType);
        if (newVersion) {
          const fullNewTag = `${prefix}${newVersion}${suffix}`;
          this.updateButton(
            index,
            fullNewTag,
            `Create and push ${type} tag version ${fullNewTag} for ${owner}/${repo}`
          );
          this.buttons[index].command = `extension.create${type.charAt(0).toUpperCase() + type.slice(1)}Tag`;
          this.buttons[index].show();
        }
      });
    } else {
      Logger.log(`Invalid tag format: ${latestTag}`, "WARNING");
    }
  }

  public async updateCommitCountButton(forceRefresh: boolean = false) {
    if (!this.cachedData.currentBranch || !this.cachedData.defaultBranch || !this.cachedData.ownerAndRepo) {
      Logger.log("Unable to update commit count button: missing branch or repo information", "WARNING");
      return;
    }

    const {owner, repo} = this.cachedData.ownerAndRepo;
    const cleanCurrentBranch = (this.cachedData.currentBranch || "").replace(/^origin\//, "");
    const cleanDefaultBranch = (this.cachedData.defaultBranch || "").replace(/^origin\//, "");
    const isDefaultBranch = cleanCurrentBranch === cleanDefaultBranch;

    let unreleasedCount = 0;
    let unmergedCount = 0;

    if (isDefaultBranch && this.cachedData.latestTag?.latest) {
      unreleasedCount = await this.gitService.getCommitCounts(
        this.cachedData.latestTag.latest,
        this.cachedData.defaultBranch,
        forceRefresh
      );
    } else if (!isDefaultBranch) {
      unmergedCount = await this.gitService.getCommitCounts(
        this.cachedData.defaultBranch,
        this.cachedData.currentBranch,
        forceRefresh
      );
      if (this.cachedData.latestTag?.latest) {
        unreleasedCount = await this.gitService.getCommitCounts(
          this.cachedData.latestTag.latest,
          this.cachedData.defaultBranch,
          forceRefresh
        );
      }
    }

    // Update the cached unreleased count for consistency
    this.cachedData.unreleasedCount = unreleasedCount;

    let buttonText = "";
    let tooltipText = "";

    if (isDefaultBranch) {
      if (!this.cachedData.latestTag?.latest) {
        const totalCommits = await this.gitService.getCommitCounts(null, this.cachedData.currentBranch, forceRefresh);
        buttonText = `${totalCommits} unreleased commits`;
        tooltipText = `${totalCommits} unreleased commits in ${owner}/${repo}/${this.cachedData.currentBranch}\nClick to open compare view for all commits`;
      } else {
        buttonText = `${unreleasedCount} unreleased commits`;
        tooltipText = `${unreleasedCount} unreleased commits in ${owner}/${repo}/${this.cachedData.currentBranch} since tag ${this.cachedData.latestTag.latest}\nClick to open compare view for unreleased commits`;
      }
    } else {
      if (unmergedCount > 0) {
        buttonText = `${unmergedCount} unmerged commits`;
        tooltipText = `${unmergedCount} unmerged commits in ${owner}/${repo}/${this.cachedData.currentBranch} compared to ${this.cachedData.defaultBranch}`;
      } else {
        buttonText = `No unmerged commits`;
        tooltipText = `All commits in ${owner}/${repo}/${this.cachedData.currentBranch} are merged to ${this.cachedData.defaultBranch}`;
      }

      if (unreleasedCount > 0) {
        buttonText += `, ${unreleasedCount} unreleased`;
        tooltipText += `\n${unreleasedCount} unreleased commits on ${owner}/${repo}/${this.cachedData.defaultBranch} since tag ${this.cachedData.latestTag?.latest}`;
      }

      tooltipText += `\nClick to open compare view`;
    }

    const buttonIndex = 4;
    Logger.log(`Commit count button updated: ${buttonText}`, "INFO");
    this.updateButton(buttonIndex, buttonText, tooltipText);
    this.buttons[buttonIndex].command = "extension.openCompareLink";
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
      case "success":
      case "completed":
        return "$(check)";
      case "failure":
      case "failed":
        return "$(x)";
      case "cancelled":
      case "canceled":
        return "$(circle-slash)";
      case "action_required":
      case "manual":
        return "$(alert)";
      case "in_progress":
      case "running":
        return "$(sync~spin)";
      case "queued":
      case "created":
      case "scheduled":
        return "$(clock)";
      case "requested":
      case "waiting":
      case "waiting_for_resource":
        return "$(watch)";
      case "pending":
      case "preparing":
        return "$(clock)";
      case "neutral":
        return "$(dash)";
      case "skipped":
        return "$(skip)";
      case "stale":
        return "$(history)";
      case "timed_out":
        return "$(clock)";
      default:
        return "$(question)";
    }
  }

  public async reloadEverything(forceRefresh: boolean = true) {
    this.clearAllItems();
    await this.updateEverything(forceRefresh);
  }

  public async updateEverything(forceRefresh: boolean = false): Promise<void> {
    const previousData = {...this.cachedData};
    if (forceRefresh) {
      this.clearCache();
    }

    await this.updateCachedData(forceRefresh);

    // Check if there are actual changes in the data
    if (!forceRefresh && JSON.stringify(previousData) === JSON.stringify(this.cachedData)) {
      Logger.log("No changes detected, skipping update", "INFO");
      return;
    }

    if (this.cachedData.currentBranch && this.cachedData.ownerAndRepo && this.cachedData.defaultBranch) {
      const {owner, repo} = this.cachedData.ownerAndRepo;
      const ciType = await this.gitService.detectCIType();

      await Promise.all([
        this.updateVersionButtons(),
        this.updateCommitCountButton(forceRefresh),
        this.updateCompareUrl(),
        ...(ciType
          ? [
              this.updateBuildStatus(this.cachedData.currentBranch, owner, repo, ciType, false, forceRefresh),
              this.cachedData.latestTag?.latest
                ? this.updateBuildStatus(this.cachedData.latestTag.latest, owner, repo, ciType, true, forceRefresh)
                : Promise.resolve()
            ]
          : [])
      ]);

      if (!ciType) {
        Logger.log("CI type not detected, skipping build status updates", "WARNING");
      }
    }
  }

  private async updateCachedData(forceRefresh: boolean = false): Promise<void> {
    const [currentBranch, defaultBranch, ownerAndRepo, latestTag] = await Promise.all([
      this.gitService.getCurrentBranch(),
      this.gitService.getDefaultBranch(),
      this.gitService.getOwnerAndRepo(),
      this.gitService.fetchAndTags(forceRefresh)
    ]);

    this.cachedData.currentBranch = currentBranch;
    this.cachedData.defaultBranch = defaultBranch;
    this.cachedData.ownerAndRepo = ownerAndRepo || null;
    this.cachedData.latestTag = latestTag;

    Logger.log(
      `Cached data updated: currentBranch=${currentBranch}, defaultBranch=${defaultBranch}, latestTag=${latestTag?.latest}`,
      "INFO"
    );

    if (currentBranch && defaultBranch) {
      const fromRef = latestTag?.latest || (await this.gitService.getInitialCommit());
      this.cachedData.unreleasedCount = await this.gitService.getCommitCounts(fromRef, currentBranch);
      Logger.log(
        `Unreleased count calculated: ${this.cachedData.unreleasedCount} (from ${fromRef} to ${currentBranch})`,
        "INFO"
      );
    } else {
      this.cachedData.unreleasedCount = null;
      Logger.log("Unable to calculate unreleased count: missing branch information", "INFO");
    }
  }

  private clearCache(): void {
    this.cachedData = {
      currentBranch: null,
      defaultBranch: null,
      latestTag: null,
      unreleasedCount: null,
      ownerAndRepo: null
    };
  }

  public clearBranchBuildStatus() {
    this.branchBuildStatusItem.hide();
  }

  public clearAllBuildStatus() {
    this.branchBuildStatusItem.hide();
    this.tagBuildStatusItem.hide();
  }

  public clearAllItems() {
    this.branchBuildStatusItem.hide();
    this.tagBuildStatusItem.hide();
    this.buttons.forEach(button => button.hide());
    this.cachedData = {
      currentBranch: null,
      defaultBranch: null,
      latestTag: null,
      unreleasedCount: null,
      ownerAndRepo: null
    };
  }

  private async updateBuildStatus(
    ref: string,
    owner: string,
    repo: string,
    ciType: "github" | "gitlab",
    isTag: boolean,
    forceRefresh: boolean = false
  ) {
    try {
      const buildStatus = await this.ciService.getBuildStatus(ref, owner, repo, ciType, isTag, forceRefresh);
      if (buildStatus) {
        await this.updateCIStatus(buildStatus.status, ref, buildStatus.url, isTag);
        this.lastKnownStatuses[ref] = buildStatus.status;
        if (this.ciService.isInProgressStatus(buildStatus.status)) {
          this.startRefreshing(ref, isTag);
        } else {
          this.stopRefreshing(ref, isTag);
        }
      } else {
        if (isTag) {
          this.clearTagBuildStatus();
        } else {
          this.clearBranchBuildStatus();
        }
      }
    } catch (error) {
      Logger.log(
        `Error updating ${isTag ? "tag" : "branch"} build status: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "ERROR"
      );
      if (isTag) {
        this.clearTagBuildStatus();
      } else {
        this.clearBranchBuildStatus();
      }
    }
  }

  private handleActiveEditorChange() {
    const initialized = this.gitService.isInitialized();
    if (initialized) {
      this.updateEverything(false);
    } else {
      // Only clear items if the repository is not valid
      if (!this.gitService.getActiveRepository()) {
        this.clearAllItems();
      }
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
      if (!this.cachedData.currentBranch || !this.cachedData.defaultBranch || !this.cachedData.ownerAndRepo) {
        Logger.log("Missing required information for compare URL", "WARNING");
        this.compareUrl = undefined;
        return;
      }

      const {owner, repo} = this.cachedData.ownerAndRepo;
      const repoInfo = await this.getBaseUrl();
      if (!repoInfo) {
        Logger.log("Unable to determine base URL for repository", "WARNING");
        this.compareUrl = undefined;
        return;
      }

      const {baseUrl, projectPath} = repoInfo;

      const cleanDefaultBranch = (this.cachedData.defaultBranch || "").replace(/^origin\//, "");
      const cleanCurrentBranch = (this.cachedData.currentBranch || "").replace(/^origin\//, "");

      if (cleanCurrentBranch !== cleanDefaultBranch) {
        this.compareUrl = `${baseUrl}/${projectPath}/compare/${cleanDefaultBranch}...${cleanCurrentBranch}`;
      } else {
        // Default branch: compare latest tag to current branch
        if (this.cachedData.latestTag?.latest) {
          this.compareUrl = `${baseUrl}/${projectPath}/compare/${this.cachedData.latestTag.latest}...${cleanDefaultBranch}`;
        } else {
          const initialCommit = await this.gitService.getInitialCommit();
          this.compareUrl = `${baseUrl}/${projectPath}/compare/${initialCommit}...${cleanDefaultBranch}`;
        }
      }
      Logger.log(`Compare URL updated: ${this.compareUrl}`, "INFO");
    } catch (error) {
      Logger.log(`Error generating compare URL: ${error instanceof Error ? error.message : String(error)}`, "ERROR");
      this.compareUrl = undefined;
    }
  }

  private async getBaseUrl(): Promise<{baseUrl: string; projectPath: string} | null> {
    const remoteUrl = await this.gitService.getRemoteUrl();
    if (!remoteUrl) {
      Logger.log("No remote URL found", "WARNING");
      return null;
    }

    let match;
    if (remoteUrl.startsWith("git@")) {
      // SSH URL
      match = remoteUrl.match(/git@([^:]+):(.+)\.git$/);
      if (match) {
        const [, domain, path] = match;
        return {
          baseUrl: `https://${domain}`,
          projectPath: path
        };
      }
    } else if (remoteUrl.startsWith("https://")) {
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

    Logger.log(`Unable to parse remote URL: ${remoteUrl}`, "WARNING");
    return null;
  }

  private async handleRepoChange({
    oldRepo,
    newRepo,
    oldBranch,
    newBranch
  }: {
    oldRepo: string | null;
    newRepo: string | null;
    oldBranch: string | null;
    newBranch: string | null;
  }) {
    if (!newRepo) {
      Logger.log("No valid repository detected, clearing status bar.", "INFO");
      this.clearAllItems();
      return;
    }

    if (oldRepo !== newRepo) {
      Logger.log(`Repository changed from ${oldRepo} to ${newRepo}`, "INFO");

      // Clear existing status
      this.clearAllItems();

      // Clear CI service cache
      this.ciService.clearCache();

      // Force refresh tags
      await this.gitService.fetchAndTags(true);

      // Force refresh for the new repository
      await this.updateEverything(true);
    }

    // Handle branch change if it occurred during repo change
    if (oldBranch !== newBranch) {
      await this.handleBranchChange({oldBranch, newBranch});
    }
  }

  private async handleBranchChange({oldBranch, newBranch}: {oldBranch: string | null; newBranch: string | null}) {
    if (newBranch === null) {
      Logger.log("Unable to determine current branch", "WARNING");
      this.clearAllItems();
      return;
    }

    Logger.log(`Branch changed from ${oldBranch} to ${newBranch}`, "INFO");

    // Stop refreshing the previous branch if it's not in progress
    if (oldBranch && oldBranch !== newBranch) {
      const previousStatus = this.lastKnownStatuses[oldBranch];
      if (!this.ciService.isInProgressStatus(previousStatus)) {
        this.stopRefreshing(oldBranch, false);
      }
    }

    // Clear existing status
    this.clearAllItems();

    // Force refresh for the new branch
    await this.updateEverything(true);

    // Start refreshing if the new branch is in progress
    const currentStatus = this.lastKnownStatuses[newBranch];
    if (this.ciService.isInProgressStatus(currentStatus)) {
      this.startRefreshing(newBranch, false);
    }
  }

  private startRefreshing(ref: string, isTag: boolean) {
    const key = `${isTag ? "tag" : "branch"}:${ref}`;
    if (this.inProgressRefreshIntervals[key]) {
      clearInterval(this.inProgressRefreshIntervals[key]);
    }
    this.inProgressRefreshIntervals[key] = setInterval(() => {
      this.refreshStatus(ref, isTag);
    }, 10000); // Refresh every 10 seconds
  }

  private stopRefreshing(ref: string, isTag: boolean) {
    const key = `${isTag ? "tag" : "branch"}:${ref}`;
    if (this.inProgressRefreshIntervals[key]) {
      clearInterval(this.inProgressRefreshIntervals[key]);
      delete this.inProgressRefreshIntervals[key];
    }
  }

  private async refreshStatus(ref: string, isTag: boolean) {
    const ownerAndRepo = await this.gitService.getOwnerAndRepo();
    const ciType = this.gitService.detectCIType();
    if (ownerAndRepo && ciType) {
      const {owner, repo} = ownerAndRepo;
      const buildStatus = await this.ciService.getBuildStatus(ref, owner, repo, ciType, isTag, true);
      if (buildStatus) {
        await this.updateCIStatus(buildStatus.status, ref, buildStatus.url, isTag);
        this.lastKnownStatuses[ref] = buildStatus.status;
        if (!this.ciService.isInProgressStatus(buildStatus.status)) {
          this.stopRefreshing(ref, isTag);
        }
      }
    }
  }

  private async refreshAfterPush() {
    Logger.log("Refreshing branch build status after push", "INFO");
    const currentBranch = await this.gitService.getCurrentBranch();
    const ownerAndRepo = await this.gitService.getOwnerAndRepo();
    const ciType = this.gitService.detectCIType();

    if (currentBranch && ownerAndRepo && ciType) {
      const {owner, repo} = ownerAndRepo;
      await this.updateBuildStatus(currentBranch, owner, repo, ciType, false, true);
      await this.updateCommitCountButton(true);
      await this.updateVersionButtons();
      await this.updateCompareUrl();
    }
  }

  public triggerUpdate(forceRefresh: boolean = false): void {
    this.debouncedUpdateEverything(forceRefresh);
  }
}
