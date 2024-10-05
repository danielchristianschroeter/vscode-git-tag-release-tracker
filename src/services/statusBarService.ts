import * as vscode from "vscode";
import { GitService } from './gitService';
import { CIService } from './ciService';

export class StatusBarService {
  private statusBarItem: vscode.StatusBarItem;
  private buildStatusItem: vscode.StatusBarItem;
  private branchBuildStatusItem: vscode.StatusBarItem;
  private buttons: vscode.StatusBarItem[];
  private lastBuildStatus: { ref: string; status: string; url: string } | null = null;
  private lastBranchBuildStatus: { branch: string; status: string; url: string } | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;
  private lastRefreshTime: number = 0;
  private backoffTime: number = 1000; // Start with 1 second
  private refreshCount: number = 0;
  private refreshTimeout: NodeJS.Timeout | null = null;

  constructor(private buttonCommands: string[], private context: vscode.ExtensionContext, private gitService: GitService, private ciService: CIService) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.buildStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.buildStatusItem.command = 'extension.openBuildStatus';
    this.branchBuildStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    this.branchBuildStatusItem.command = 'extension.openBranchBuildStatus';
    this.buttons = buttonCommands.map((command, index) => {
      const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97 - index);
      button.command = command;
      return button;
    });
    this.context.subscriptions.push(this.statusBarItem, this.buildStatusItem, this.branchBuildStatusItem, ...this.buttons);
    this.startPeriodicRefresh();
  }

  private startPeriodicRefresh() {
    // Initial refresh after 10 seconds
    this.refreshTimeout = setTimeout(() => this.refreshCurrentBranchStatus(), 10000);
  }

  private async refreshCurrentBranchStatus() {
    const currentTime = Date.now();
    if (currentTime - this.lastRefreshTime < this.backoffTime) {
      console.log('Skipping refresh due to backoff');
      this.scheduleNextRefresh();
      return;
    }

    try {
      const currentBranch = this.gitService.getCurrentBranch();
      const { owner, repo } = await this.gitService.getOwnerAndRepo();
      const ciType = this.gitService.detectCIType();

      if (owner && repo && ciType) {
        const { status, url } = await this.ciService.getImmediateBuildStatus(currentBranch, owner, repo, ciType, false);
        this.updateBranchBuildStatus(status, currentBranch, url);
        this.lastRefreshTime = currentTime;
        this.backoffTime = 1000; // Reset backoff time on successful refresh
        this.refreshCount++;
        this.scheduleNextRefresh();
      }
    } catch (error) {
      console.error('Error refreshing branch status:', error);
      if (error instanceof Error && error.message.includes('rate limit')) {
        // Likely hit rate limit, increase backoff time
        this.backoffTime = Math.min(this.backoffTime * 2, 30 * 60 * 1000); // Max 30 minutes
        console.log(`Increased backoff time to ${this.backoffTime}ms`);
      } else {
        // Handle other types of errors
        vscode.window.showErrorMessage(`Error refreshing branch status: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      this.scheduleNextRefresh();
    }
  }

  private scheduleNextRefresh() {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }

    const nextInterval = this.calculateNextInterval();
    this.refreshTimeout = setTimeout(() => this.refreshCurrentBranchStatus(), nextInterval);
  }

  private calculateNextInterval(): number {
    // Start with 10 seconds, then 30, 60, 120, 300, up to 15 minutes
    const intervals = [10000, 30000, 60000, 120000, 300000, 900000];
    return intervals[Math.min(this.refreshCount, intervals.length - 1)];
  }

  async refreshCIStatus() {
    // Reset the refresh count to trigger more frequent updates
    this.refreshCount = 0;
    this.backoffTime = 1000;
    await this.refreshCurrentBranchStatus();
  }

  openBranchBuildStatus() {
    if (this.lastBranchBuildStatus && this.lastBranchBuildStatus.url) {
      vscode.env.openExternal(vscode.Uri.parse(this.lastBranchBuildStatus.url));
    } else {
      vscode.window.showInformationMessage('No build status URL available to open.');
    }
  }

  updateStatusBar(text: string, tooltip: string, command?: string) {
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.command = command;
    this.statusBarItem.show();
  }

  updateBuildStatus(status: string, tag: string, url: string) {
    if (status === 'no_runs') {
      this.buildStatusItem.text = `$(circle-slash) No builds for ${tag}`;
      this.buildStatusItem.tooltip = `No builds found for tag ${tag}`;
    } else {
      const icon = this.getStatusIcon(status);
      this.buildStatusItem.text = `${icon} Tag build ${status} for ${tag}`;
      this.buildStatusItem.tooltip = `Click to view tag build status for ${tag}`;
    }
    this.buildStatusItem.command = {
      command: 'extension.openBuildStatus',
      title: 'Open Build Status',
      arguments: [url]
    };
    this.buildStatusItem.show();
    this.lastBuildStatus = { ref: tag, status, url };
  }

  updateBranchBuildStatus(status: string, branch: string, url: string) {
    if (status === 'no_runs') {
      this.branchBuildStatusItem.text = `$(circle-slash) No builds for ${branch}`;
      this.branchBuildStatusItem.tooltip = `No builds found for branch ${branch}`;
    } else {
      const icon = this.getStatusIcon(status);
      this.branchBuildStatusItem.text = `${icon} Branch build ${status} for ${branch}`;
      this.branchBuildStatusItem.tooltip = `Click to view branch build status for ${branch}`;
    }
    this.branchBuildStatusItem.command = {
      command: 'extension.openBranchBuildStatus',
      title: 'Open Branch Build Status',
      arguments: [url]
    };
    this.branchBuildStatusItem.show();
    this.lastBranchBuildStatus = { branch, status, url };
  }

  getLastBranchBuildStatus() {
    return this.lastBranchBuildStatus;
  }

  clearStatusBar() {
    this.statusBarItem.text = '';
    this.statusBarItem.tooltip = '';
    this.statusBarItem.command = undefined;
    this.statusBarItem.hide();
    this.hideButtons();
    this.hideBuildStatus();
    this.hideBranchBuildStatus();
  }

  showButtons() {
    this.buttons.forEach(button => button.show());
  }

  hideBuildStatus() {
    this.buildStatusItem.hide();
  }

  hideBranchBuildStatus() {
    this.branchBuildStatusItem.hide();
  }

  hideButtons() {
    this.buttons.forEach(button => button.hide());
  }

  updateButton(index: number, text: string, tooltip: string) {
    if (index >= 0 && index < this.buttons.length) {
      const button = this.buttons[index];
      button.text = text;
      button.tooltip = tooltip;
    }
  }

  dispose() {
    this.statusBarItem.dispose();
    this.buildStatusItem.dispose();
    this.branchBuildStatusItem.dispose();
    this.buttons.forEach(button => button.dispose());
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
  }

  private isPendingStatus(status: string): boolean {
    const pendingStatuses = ['in_progress', 'queued', 'pending', 'running', 'waiting'];
    return pendingStatuses.includes(status);
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
}