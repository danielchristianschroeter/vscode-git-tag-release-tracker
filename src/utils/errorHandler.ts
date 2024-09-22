import * as vscode from "vscode";

export function showError(error: unknown, message: string) {
  if (error instanceof Error) {
    vscode.window.showErrorMessage(`${message}: ${error.message}`);
  } else {
    vscode.window.showErrorMessage(`${message}: An unknown error occurred.`);
  }
}
