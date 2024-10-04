import * as vscode from "vscode";

export function showError(error: any, context: string) {
  console.error(`${context}:`, error);
  let errorMessage = error.message || String(error);
  
  if (errorMessage.includes("src refspec") && errorMessage.includes("does not match any")) {
    errorMessage = "Failed to push the tag. Please try again in a few seconds.";
  }
  
  return vscode.window.showErrorMessage(`${context}: ${errorMessage}`);
}
