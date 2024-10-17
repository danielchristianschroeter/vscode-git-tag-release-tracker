import * as vscode from "vscode";

export class Logger {
  private static outputChannel: vscode.OutputChannel;

  static initialize(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("Git Tag Release Tracker", "log");
    context.subscriptions.push(this.outputChannel);
  }

  static log(message: string, level: "DEBUG" | "INFO" | "WARNING" | "ERROR" = "INFO") {
    if (!this.outputChannel) {
      console.warn("Logger not initialized");
      return;
    }

    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);

    if (level === "ERROR") {
      vscode.window.showErrorMessage(message);
    }
  }

  static show() {
    if (this.outputChannel) {
      this.outputChannel.show();
    }
  }
}
