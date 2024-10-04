import * as vscode from "vscode";

export class StatusBarService {
  private statusBarItem: vscode.StatusBarItem;
  private buildStatusItem: vscode.StatusBarItem;
  private buttons: vscode.StatusBarItem[];
  private lastCheckedBuildStatus: { tag: string, status: string } = { tag: '', status: '' };
  private lastBuildStatus: { tag: string; status: string; url: string } | null = null;
  private ciConfigured: boolean = false;

  constructor(buttonCommands: string[], private context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.buildStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.buildStatusItem.command = 'extension.openBuildStatus';
    this.buttons = buttonCommands.map((command, index) => {
      const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98 - index);
      button.command = command;
      return button;
    });
    this.context.subscriptions.push(this.statusBarItem, this.buildStatusItem, ...this.buttons);
  }

  setCIConfigured(configured: boolean) {
    this.ciConfigured = configured;
  }

  updateStatusBar(text: string, tooltip: string, command?: string) {
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    if (command) {
      this.statusBarItem.command = command;
    }
    this.statusBarItem.show();
  }

  updateBuildStatus(status: string, tag: string, url: string) {
    console.log(`StatusBarService received status: ${status} for tag: ${tag}`);
    this.lastBuildStatus = { tag, status, url };
    this.renderBuildStatus();
  }

  private renderBuildStatus() {
    if (!this.lastBuildStatus) {
      this.buildStatusItem.hide();
      return;
    }

    const { status, tag } = this.lastBuildStatus;
    switch (status) {
      case 'success':
        this.buildStatusItem.text = '$(check)';
        this.buildStatusItem.tooltip = `Build successful for tag ${tag}`;
        break;
      case 'failure':
      case 'cancelled':
      case 'timed_out':
        this.buildStatusItem.text = '$(x)';
        this.buildStatusItem.tooltip = `Build ${status} for tag ${tag}`;
        break;
      case 'action_required':
        this.buildStatusItem.text = '$(alert)';
        this.buildStatusItem.tooltip = 'Action required';
        break;
      case 'neutral':
      case 'skipped':
        this.buildStatusItem.text = '$(dash)';
        this.buildStatusItem.tooltip = `Build ${status}`;
        break;
      case 'stale':
        this.buildStatusItem.text = '$(clock)';
        this.buildStatusItem.tooltip = 'Build stale';
        break;
      case 'in_progress':
      case 'queued':
      case 'requested':
      case 'waiting':
      case 'pending':
        this.buildStatusItem.text = '$(sync~spin)';
        this.buildStatusItem.tooltip = 'Build in progress';
        break;
      default:
        this.buildStatusItem.text = '$(question)';
        this.buildStatusItem.tooltip = `Build status unknown for tag ${tag}`;
    }
    this.buildStatusItem.show();
  }

  hideBuildStatus() {
    this.buildStatusItem.hide();
  }

  hideButtons() {
    this.buttons.forEach((button) => button.hide());
  }

  showButtons() {
    this.buttons.forEach((button) => button.show());
  }

  updateButton(buttonIndex: number, text: string, tooltip: string) {
    const button = this.buttons[buttonIndex];
    button.text = text;
    button.tooltip = tooltip;
    button.show();
  }

  getLastCheckedBuildStatus() {
    return this.lastCheckedBuildStatus;
  }

  getLastBuildStatus() {
    return this.lastBuildStatus;
  }

  clearStatusBar() {
    this.statusBarItem.text = "";
    this.statusBarItem.tooltip = "";
    this.statusBarItem.command = undefined;
    this.buildStatusItem.hide();
    this.hideButtons();
    this.lastBuildStatus = null;
  }
}
