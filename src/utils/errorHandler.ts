import * as vscode from "vscode";
import {Logger} from "./logger";

export function handleError(error: any, context: string) {
  Logger.log(`${context}: ${error instanceof Error ? error.message : String(error)}`, "ERROR");
  let errorMessage = error instanceof Error ? error.message : String(error);

  if (errorMessage.includes("src refspec") && errorMessage.includes("does not match any")) {
    errorMessage = "Failed to push the tag. Please try again in a few seconds.";
  }

  vscode.window.showErrorMessage(`${context}: ${errorMessage}`);
}
