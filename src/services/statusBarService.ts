import * as vscode from "vscode";

export class StatusBarService {
  private statusBar: vscode.StatusBarItem;
  private buttons: vscode.StatusBarItem[];

  constructor(buttonCommands: string[], context: vscode.ExtensionContext) {
    const priorities = [100, 99, 98, 97, 96];
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      priorities[0]
    );

    this.buttons = buttonCommands.slice(0, 3).map((command, index) => {
      const button = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        priorities[index + 1]
      );
      button.command = command;
      context.subscriptions.push(button);
      return button;
    });

    context.subscriptions.push(this.statusBar, ...this.buttons);
  }

  updateStatusBar(text: string, tooltip: string, command?: string) {
    this.statusBar.text = text;
    this.statusBar.tooltip = tooltip;
    this.statusBar.command = command;
    this.statusBar.show();
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
}
