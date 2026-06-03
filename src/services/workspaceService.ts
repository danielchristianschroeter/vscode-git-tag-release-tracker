import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

export class WorkspaceService {
    private readonly fallbackSearchMaxDepth = 4;
    private readonly ignoredDirectoryNames = new Set([
        '.git',
        '.vscode',
        '.vscode-test',
        'dist',
        'node_modules',
        'out'
    ]);

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

        const repoPaths = new Set<string>();
        const repositories = gitApi.repositories;
        if (repositories?.length) {
            repositories.forEach((repo: any) => repoPaths.add(repo.rootUri.fsPath));
        }

        const scannedRepoPaths = await this.findGitRepositoryRootsInWorkspace();
        scannedRepoPaths.forEach(repoPath => repoPaths.add(repoPath));

        if (repoPaths.size === 0) {
            Logger.log('No Git repositories found in the workspace.', 'INFO');
            return [];
        }

        const sortedRepoPaths = Array.from(repoPaths).sort((a, b) => a.localeCompare(b));
        Logger.log(`Found repositories: ${sortedRepoPaths.join(', ')}`, 'INFO');
        return sortedRepoPaths;
    }

    private async findGitRepositoryRootsInWorkspace(): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const repoRoots = new Set<string>();

        for (const folder of workspaceFolders) {
            await this.scanDirectoryForGitRepositories(folder.uri.fsPath, this.fallbackSearchMaxDepth, repoRoots);
        }

        return Array.from(repoRoots);
    }

    private async scanDirectoryForGitRepositories(
        directoryPath: string,
        remainingDepth: number,
        repoRoots: Set<string>
    ): Promise<void> {
        let entries: fs.Dirent[];

        try {
            entries = await fs.promises.readdir(directoryPath, {withFileTypes: true});
        } catch (error) {
            Logger.log(`Could not scan directory for Git repositories: ${directoryPath}`, 'WARNING');
            return;
        }

        if (entries.some(entry => entry.name === '.git')) {
            repoRoots.add(directoryPath);
            return;
        }

        if (remainingDepth <= 0) {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || this.ignoredDirectoryNames.has(entry.name)) {
                continue;
            }

            await this.scanDirectoryForGitRepositories(
                path.join(directoryPath, entry.name),
                remainingDepth - 1,
                repoRoots
            );
        }
    }
} 
