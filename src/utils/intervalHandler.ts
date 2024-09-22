import * as vscode from "vscode";

export function createInterval(
  callback: () => void,
  interval: number
): vscode.Disposable {
  const handle = setInterval(callback, interval);
  return { dispose: () => clearInterval(handle) };
}
