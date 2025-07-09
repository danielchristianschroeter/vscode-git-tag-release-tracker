import { Uri, Event } from "vscode";

export interface GitExtension {
  getAPI(version: 1): API;
}

export interface API {
  state: "uninitialized" | "initialized";
  onDidOpenRepository: Event<Repository>;
  onDidCloseRepository: Event<Repository>;
  repositories: Repository[];
}

export interface Repository {
  rootUri: Uri;
} 