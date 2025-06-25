import * as vscode from "vscode";
import {CIService} from "./services/ciService";
import {GitService} from "./services/gitService";
import {StatusBarService} from "./services/statusBarService";

export const globals: {
  context: vscode.ExtensionContext | null;
  gitService: GitService | null;
  statusBarService: StatusBarService | null;
  ciService: CIService | null;
  isInitialized: boolean;
} = {
  context: null,
  gitService: null,
  statusBarService: null,
  ciService: null,
  isInitialized: false
};
