import * as vscode from "vscode";
import { GitService, TagResult } from "./gitService";
import { CIService } from "./ciService";
import { Logger } from "../utils/logger";
import { debounce } from "../utils/debounce";
import { RepositoryServices } from "../globals";
import path from "path";
import { AggregatedData, MultiRepoService } from "./multiRepoService";

export class StatusBarService {
  private aggregatedStatusItem: vscode.StatusBarItem;
  private branchBuildStatusItem: vscode.StatusBarItem;
  private tagBuildStatusItem: vscode.StatusBarItem;
  private debouncedUpdateEverything = debounce(async (forceRefresh: boolean = false) => {
    await this.updateEverything(forceRefresh);
  }, 2000);
  private debouncedHandleActiveEditorChange = debounce(() => this.handleActiveEditorChange(), 300);
  private multiRepoService: MultiRepoService;
  private isLoading: boolean = true;
  private activeRepoRoot: string | undefined;
  private lastAggregatedData: AggregatedData | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repositoryServices: Map<string, RepositoryServices>
  ) {
    this.multiRepoService = new MultiRepoService(repositoryServices);
    this.aggregatedStatusItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.branchBuildStatusItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.tagBuildStatusItem = this.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    vscode.window.onDidChangeActiveTextEditor(() => this.debouncedHandleActiveEditorChange());

    Logger.log("StatusBarService constructor called", "INFO");

    // Show loading indicator immediately
    this.showLoadingIndicator();

    // Then update everything
    this.updateEverything(true);
  }

  private createStatusBarItem(alignment: vscode.StatusBarAlignment, priority: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(alignment, priority);
    this.context.subscriptions.push(item);
    return item;
  }

  private showLoadingIndicator() {
    this.isLoading = true;
    this.aggregatedStatusItem.text = "$(sync~spin) Loading Git repositories...";
    this.aggregatedStatusItem.tooltip = "Git Tag Release Tracker is loading repository information...";
    this.aggregatedStatusItem.show();
  }

  public clearStatusBar() {
    this.aggregatedStatusItem.hide();
    this.branchBuildStatusItem.hide();
    this.tagBuildStatusItem.hide();
  }

  public async reloadEverything(forceRefresh: boolean = true) {
    // Show loading indicator when explicitly reloading
    this.showLoadingIndicator();
    await this.updateEverything(forceRefresh);
  }

  public async updateEverything(forceRefresh: boolean = false): Promise<void> {
    Logger.log("Updating everything for all repositories...", "INFO");
    
    if (forceRefresh) {
      this.showLoadingIndicator();
    }
    
    const aggregatedData = await this.multiRepoService.getAggregatedData(forceRefresh);
    this.lastAggregatedData = aggregatedData;
    
    this.updateAggregatedHover(aggregatedData);

    // Mark loading completed before updating visible text
    this.isLoading = false;

    // Update text for active repo / totals
    this.handleActiveEditorChange();
    // If there is no active editor we still need one more update
    this.updateAggregatedStatusText();
  }

  private updateActiveRepoStatusItems() {
    if (!this.activeRepoRoot) {
      this.branchBuildStatusItem.hide();
    this.tagBuildStatusItem.hide();
      return;
    }

    const repoData = this.multiRepoService.getRepoDataForRoot(this.activeRepoRoot);
    if (!repoData) {
      this.branchBuildStatusItem.hide();
      this.tagBuildStatusItem.hide();
      return;
    }

    // Update branch build status item
    if (repoData.branchBuildStatus && repoData.currentBranch) {
      const cleanBranchName = repoData.currentBranch.replace(/^origin\//, '');
      this.branchBuildStatusItem.text = `${repoData.branchBuildStatus.icon} ${cleanBranchName}`;
      this.branchBuildStatusItem.tooltip = `Branch: ${repoData.currentBranch}\nStatus: ${repoData.branchBuildStatus.status}`;
      this.branchBuildStatusItem.command = {
        title: "Open Branch Build Status",
        command: "extension.openBranchBuildStatus",
        arguments: [repoData.branchBuildStatus.url]
      };
      this.branchBuildStatusItem.show();
      } else {
      this.branchBuildStatusItem.hide();
    }

    // Update tag build status item
    if (repoData.tagBuildStatus) {
      this.tagBuildStatusItem.text = `${repoData.tagBuildStatus.icon} Tag: ${repoData.latestTag?.latest}`;
      this.tagBuildStatusItem.tooltip = `Tag: ${repoData.latestTag?.latest}\nStatus: ${repoData.tagBuildStatus.status}`;
      this.tagBuildStatusItem.command = {
          title: "Open Tag Build Status",
          command: "extension.openTagBuildStatus",
          arguments: [repoData.tagBuildStatus.url]
      };
      this.tagBuildStatusItem.show();
    } else {
      this.tagBuildStatusItem.hide();
    }
  }

  private updateAggregatedHover(aggregatedData: AggregatedData) {
    const { repoData } = aggregatedData;

    const hoverMessage = new vscode.MarkdownString("### Git Tag Release Tracker\n\n");
    hoverMessage.isTrusted = true;
    hoverMessage.supportThemeIcons = true;

    if (repoData.length === 0) {
      hoverMessage.appendMarkdown("No Git repositories found in this workspace.\n");
    } else {
      const sortedRepoData = [...repoData].sort((a, b) => {
        const aName = a.repoRoot.split(path.sep).pop() || a.repoRoot;
        const bName = b.repoRoot.split(path.sep).pop() || b.repoRoot;
        return aName.localeCompare(bName);
      });

      hoverMessage.appendMarkdown("| Repository | Branch | Latest Tag | Build Status | Unreleased | Unmerged | Actions |\n");
      hoverMessage.appendMarkdown("|:----------|:-------|:-----------|:-----------:|:---------:|:--------:|:-------:|\n");

      for (const data of sortedRepoData) {
        const repoName = data.repoRoot.split(path.sep).pop() || data.repoRoot;
        const cleanCurrentBranch = (data.currentBranch || "").replace(/^origin\//, "");
        const cleanDefaultBranch = (data.defaultBranch || "").replace(/^origin\//, "");
        const isDefaultBranch = cleanCurrentBranch === cleanDefaultBranch;
        const branchText = isDefaultBranch
          ? `${cleanDefaultBranch}`
          : `${cleanCurrentBranch} → ${cleanDefaultBranch}`;
        const latestTagText = data.latestTag?.latest ? `${data.latestTag.latest}` : "-";
        
        let buildStatusText = "";
        if (isDefaultBranch && data.tagBuildStatus && data.latestTag?.latest) {
          const statusIcon = this.getBuildStatusIcon(data.tagBuildStatus.status);
          const tooltipText = `Tag ${data.latestTag.latest} build: ${data.tagBuildStatus.status}`;
          buildStatusText = data.tagBuildStatus.url ? `[${statusIcon}](${data.tagBuildStatus.url} "${tooltipText}")` : statusIcon;
        } else if (data.branchBuildStatus) {
          const statusIcon = this.getBuildStatusIcon(data.branchBuildStatus.status);
          const tooltipText = `Branch ${cleanCurrentBranch} build: ${data.branchBuildStatus.status}`;
          buildStatusText = data.branchBuildStatus.url ? `[${statusIcon}](${data.branchBuildStatus.url} "${tooltipText}")` : statusIcon;
        } else {
          buildStatusText = "$(circle)";
        }
        
        let actionsText = "";
        if (data.hasRemote) {
          const repoRootPath = data.repoRoot;
          if (isDefaultBranch) {
            actionsText = `[$(git-compare)](command:extension.openCompareLink?${encodeURIComponent(JSON.stringify([repoRootPath, "tag"]))} "Compare changes between latest tag and current branch")`;
          } else {
            actionsText = `[$(git-compare)](command:extension.openCompareLink?${encodeURIComponent(JSON.stringify([repoRootPath, cleanDefaultBranch, cleanCurrentBranch]))} "Compare changes between ${cleanDefaultBranch} and ${cleanCurrentBranch}")`;
          }
          
          if (isDefaultBranch && data.unreleasedCount > 0 && data.latestTag?.latest) {
            const currentVersion = data.latestTag.latest.replace(/^v/, '');
            const [major, minor, patch] = currentVersion.split('.').map(Number);
            const hasPrefix = data.latestTag.latest.startsWith('v');
            const prefix = hasPrefix ? 'v' : '';
            
            const nextMajor = `${prefix}${major + 1}.0.0`;
            const nextMinor = `${prefix}${major}.${minor + 1}.0`;
            const nextPatch = `${prefix}${major}.${minor}.${patch + 1}`;

            actionsText += ` [$(arrow-up)M](command:extension.createMajorTag?${encodeURIComponent(JSON.stringify([repoRootPath]))} "Increase Major Version: ${nextMajor}")`;
            actionsText += ` [$(arrow-up)m](command:extension.createMinorTag?${encodeURIComponent(JSON.stringify([repoRootPath]))} "Increase Minor Version: ${nextMinor}")`;
            actionsText += ` [$(arrow-up)p](command:extension.createPatchTag?${encodeURIComponent(JSON.stringify([repoRootPath]))} "Increase Patch Version: ${nextPatch}")`;
          } else if (isDefaultBranch && !data.latestTag?.latest) {
            actionsText += ` [$(star-full)](command:extension.createInitialTag?${encodeURIComponent(JSON.stringify([repoRootPath]))} "Create Initial Version: 1.0.0")`;
          } else if (!isDefaultBranch) {
            actionsText += ` [$(info)](command:noop "Switch to ${cleanDefaultBranch} to create tags")`;
          }
        } else {
          actionsText = "$(error) No remote";
        }

        hoverMessage.appendMarkdown(`| ${repoName} | ${branchText} | ${latestTagText} | ${buildStatusText} | ${data.unreleasedCount} | ${data.unmergedCount} | ${actionsText} |\n`);
      }

      hoverMessage.appendMarkdown("\n\n**Legend:**\n");
      hoverMessage.appendMarkdown("- **Unreleased**: Commits on default branch since last tag\n");
      hoverMessage.appendMarkdown("- **Unmerged**: Commits on current branch not merged to default branch\n");
      hoverMessage.appendMarkdown("- **Build Status**: CI/CD build status for the current branch or tag\n");
      hoverMessage.appendMarkdown("- **Actions**: \n");
      hoverMessage.appendMarkdown("  - $(git-compare): Compare changes between branches or tags\n");
      hoverMessage.appendMarkdown("  - $(arrow-up)M/m/p: Create Major/Minor/Patch version (preserves prefixes/suffixes)\n");
      hoverMessage.appendMarkdown("  - $(star-full): Create initial version (1.0.0)\n");
    }

    this.aggregatedStatusItem.tooltip = hoverMessage;
    this.aggregatedStatusItem.command = undefined;
    this.aggregatedStatusItem.show();
  }

  private updateAggregatedStatusText() {
    if (this.isLoading || !this.lastAggregatedData) {
      this.aggregatedStatusItem.text = "$(sync~spin) Loading...";
      return;
    }

    const activeRepoData = this.activeRepoRoot
      ? this.multiRepoService.getRepoDataForRoot(this.activeRepoRoot)
      : undefined;

    if (activeRepoData) {
      this.aggregatedStatusItem.text = `$(git-commit) ${activeRepoData.unreleasedCount} unreleased, ${activeRepoData.unmergedCount} unmerged`;
    } else {
      const { totalUnreleasedCommits, totalUnmergedCommits } = this.lastAggregatedData;
      this.aggregatedStatusItem.text = `$(git-commit) ${totalUnreleasedCommits} unreleased, ${totalUnmergedCommits} unmerged`;
    }
  }

  private getBuildStatusIcon(status: string | undefined): string {
    if (!status) {
      return "$(circle)";
    }
    
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
      case "no_runs":
        return "$(dash)";
      default:
        return "$(question)";
    }
  }

  public clearAllItems() {
    this.aggregatedStatusItem.hide();
    this.branchBuildStatusItem.hide();
    this.tagBuildStatusItem.hide();
    Logger.log("All status bar items cleared", "INFO");
  }

  private handleActiveEditorChange() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const resource = editor.document.uri;
        const repoRoot = Array.from(this.repositoryServices.keys()).find(root => resource.fsPath.startsWith(root));
        this.activeRepoRoot = repoRoot;
    } else {
        this.activeRepoRoot = undefined;
    }
    this.updateActiveRepoStatusItems();
    this.updateAggregatedStatusText();
  }

  public triggerUpdate(forceRefresh: boolean = false): void {
    this.debouncedUpdateEverything(forceRefresh);
  }

  public async getCompareUrlForRepo(repoRoot: string, base?: string, head?: string): Promise<string | undefined> {
    const services = this.repositoryServices.get(repoRoot);
    if (!services) {
        return undefined;
    }

    const { gitService } = services;
    const [ownerAndRepo, latestTag, defaultBranch, currentBranch] = await Promise.all([
      gitService.getOwnerAndRepo(),
      gitService.getLatestTag(),
      gitService.getDefaultBranch(),
      gitService.getCurrentBranch()
    ]);

    if (!ownerAndRepo || !defaultBranch) {
      return undefined;
    }
    
    const baseUrl = await gitService.getBaseUrl();
    if (!baseUrl) {
      return undefined;
    }

    if (base === 'tag') {
        base = latestTag?.latest || await gitService.getInitialCommit() || defaultBranch;
        head = defaultBranch;
    } else if (!base || !head) {
        base = defaultBranch;
        head = currentBranch || '';
    }

    return `${baseUrl}/${ownerAndRepo.owner}/${ownerAndRepo.repo}/compare/${base}...${head}`;
  }
  
  public getMultiRepoService(): MultiRepoService {
    return this.multiRepoService;
  }
}
