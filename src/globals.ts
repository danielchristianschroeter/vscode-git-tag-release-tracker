import * as vscode from "vscode";
import {CIService} from "./services/ciService";
import {GitService} from "./services/gitService";
import {StatusBarService} from "./services/statusBarService";

export interface RepositoryServices {
  gitService: GitService;
  ciService: CIService;
}

export const globals: {
  context: vscode.ExtensionContext | null;
  repositoryServices: Map<string, RepositoryServices>;
  statusBarService: StatusBarService | null;
  isInitialized: boolean;
} = {
  context: null,
  repositoryServices: new Map(),
  statusBarService: null,
  isInitialized: false
};
