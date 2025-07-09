import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

export class WorkspaceService {
    public async getGitRepositoryRoots(): Promise<string[]> {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            Logger.log('Git extension is not available.', 'ERROR');
            vscode.window.showErrorMessage('Git extension is not available.');
            return [];
        }

        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }

        const gitApi = gitExtension.exports.getAPI(1);
        if (!gitApi) {
            Logger.log('Failed to get Git API.', 'ERROR');
            vscode.window.showErrorMessage('Failed to get Git API.');
            return [];
        }

        const repositories = gitApi.repositories;
        if (!repositories || repositories.length === 0) {
            Logger.log('No Git repositories found in the workspace.', 'INFO');
            vscode.window.showInformationMessage('No Git repositories found in the workspace.');
            return [];
        }

        const repoPaths = repositories.map((repo: any) => repo.rootUri.fsPath);
        Logger.log(`Found repositories: ${repoPaths.join(', ')}`, 'INFO');
        return repoPaths;
    }
} 