import { GitService, TagResult } from "./gitService";
import { RepositoryServices } from "../globals";
import { Logger } from "../utils/logger";
import { BuildStatus, CIService } from "./ciService";
import { globals } from "../globals";

export interface AggregatedData {
    totalUnreleasedCommits: number;
    totalUnmergedCommits: number;
    repoData: RepoData[];
}

export interface RepoData {
    repoRoot: string;
    currentBranch: string | null;
    defaultBranch: string | null;
    latestTag: TagResult | null;
    unreleasedCount: number;
    unmergedCount: number;
    ownerAndRepo: {
        owner: string;
        repo: string;
    } | null;
    hasRemote: boolean;
    branchBuildStatus?: BuildStatus | null;
    tagBuildStatus?: BuildStatus | null;
    ciType?: "github" | "gitlab" | null;
}

export class MultiRepoService {
    private cache: Map<string, RepoData> = new Map();
    private pollingInterval: NodeJS.Timeout | undefined;

    constructor(private repositoryServices: Map<string, RepositoryServices>) {
        this.startPolling();
    }

    public async getAggregatedData(forceRefresh: boolean = false): Promise<AggregatedData> {
        if (forceRefresh) {
            this.clearCache();
        }

        const repoDataPromises: Promise<RepoData>[] = [];
        const sortedRepos = Array.from(this.repositoryServices.entries())
            .sort(([pathA], [pathB]) => pathA.toLowerCase().localeCompare(pathB.toLowerCase()));

        for (const [repoRoot, services] of sortedRepos) {
            if (this.cache.has(repoRoot) && !forceRefresh) {
                repoDataPromises.push(Promise.resolve(this.cache.get(repoRoot)!));
            } else {
                repoDataPromises.push(this.getRepoData(repoRoot, services.gitService, services.ciService, true));
            }
        }

        const repoDataList = await Promise.all(repoDataPromises);
        
        repoDataList.forEach(data => this.cache.set(data.repoRoot, data));

        let totalUnreleasedCommits = 0;
        let totalUnmergedCommits = 0;
        for (const data of repoDataList) {
            totalUnreleasedCommits += data.unreleasedCount;
            totalUnmergedCommits += data.unmergedCount;
        }

        return {
            totalUnreleasedCommits,
            totalUnmergedCommits,
            repoData: repoDataList
        };
    }
    
    public invalidateCacheForRepo(repoRoot: string) {
        if (this.cache.has(repoRoot)) {
            const data = this.cache.get(repoRoot);
            if (data) {
                if (data.branchBuildStatus) {
                    data.branchBuildStatus.status = 'loading';
                    data.branchBuildStatus.icon = '$(sync~spin)';
                }
                if (data.tagBuildStatus) {
                    data.tagBuildStatus.status = 'loading';
                    data.tagBuildStatus.icon = '$(sync~spin)';
                }
                this.cache.set(repoRoot, data);
                // Trigger a UI update to show the loading state immediately
                globals.statusBarService?.triggerUpdate(false);
            }
            Logger.log(`Cache invalidated for ${repoRoot}`, "INFO");
        }
    }

    public getRepoDataForRoot(repoRoot: string): RepoData | undefined {
        return this.cache.get(repoRoot);
    }

    public clearCache() {
        this.cache.clear();
        Logger.log("Cleared all repository data cache.", "INFO");
    }

    private startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        this.pollingInterval = setInterval(async () => {
            await this.pollInProgressBuilds();
        }, 5000); // Poll every 5 seconds
    }

    private async pollInProgressBuilds() {
        let needsUpdate = false;
        for (const [repoRoot, data] of this.cache.entries()) {
            const services = this.repositoryServices.get(repoRoot);
            if (!services || !services.ciService || !data.ciType) {continue;}

            const ciService = services.ciService as CIService;
            
            const pollTasks: Promise<void>[] = [];

            if (data.branchBuildStatus && ciService.isInProgressStatus(data.branchBuildStatus.status)) {
                pollTasks.push(this.updateBuildStatusInternal(ciService, data, false).then(updated => {
                    if (updated) {
                        needsUpdate = true;
                    }
                }));
            }
            if (data.tagBuildStatus && ciService.isInProgressStatus(data.tagBuildStatus.status)) {
                pollTasks.push(this.updateBuildStatusInternal(ciService, data, true).then(updated => {
                    if (updated) {
                        needsUpdate = true;
                    }
                }));
            }
            await Promise.all(pollTasks);
        }

        if (needsUpdate) {
            globals.statusBarService?.triggerUpdate(false);
        }
    }
    
    private async updateBuildStatusInternal(ciService: CIService, data: RepoData, isTag: boolean): Promise<boolean> {
        const ref = isTag ? data.latestTag?.latest : data.currentBranch;
        if (!ref || !data.ciType) {
            return false;
        }

        const newStatus = await ciService.getBuildStatus(ref, data.ciType, isTag, true);
        const oldStatus = isTag ? data.tagBuildStatus : data.branchBuildStatus;

        if (JSON.stringify(newStatus) !== JSON.stringify(oldStatus)) {
            if (isTag) {
                data.tagBuildStatus = newStatus;
            } else {
                data.branchBuildStatus = newStatus;
            }
            this.cache.set(data.repoRoot, data);
            return true;
        }
        return false;
    }

    private async getRepoData(
        repoRoot: string,
        gitService: GitService,
        ciService: CIService,
        forceRefresh: boolean = false
    ): Promise<RepoData> {
        if (forceRefresh) {
            try {
                await gitService.fetchLatest();
                Logger.log(`Fetched latest changes for ${repoRoot}`, "INFO");
            } catch (error) {
                Logger.log(`Failed to fetch latest changes for ${repoRoot}: ${error}`, "WARNING");
            }
        }

        const [currentBranch, defaultBranch, ownerAndRepo, latestTag, hasRemote] = await Promise.all([
            gitService.getCurrentBranch(),
            gitService.getDefaultBranch(),
            gitService.getOwnerAndRepo(),
            gitService.getLatestTag(forceRefresh),
            gitService.hasRemote()
        ]);

        const cleanCurrentBranch = (currentBranch || "").replace(/^origin\//, "");
        const cleanDefaultBranch = (defaultBranch || "").replace(/^origin\//, "");
        const isDefaultBranch = cleanCurrentBranch === cleanDefaultBranch;

        let unreleasedCount = 0;
        let unmergedCount = 0;

        if (defaultBranch && hasRemote) {
            // Calculate unreleased commits on default branch
            if (latestTag?.latest) {
                unreleasedCount = await gitService.getCommitCounts(
                    latestTag.latest,
                    defaultBranch,
                    forceRefresh
                );
            } else if (isDefaultBranch && currentBranch) {
                // If no tags exist and we're on default branch, count all commits
                unreleasedCount = await gitService.getCommitCounts(null, currentBranch, forceRefresh);
            }

            // Calculate unmerged commits when not on default branch
            if (!isDefaultBranch && currentBranch) {
                unmergedCount = await gitService.getCommitCounts(
                    defaultBranch,
                    currentBranch,
                    forceRefresh
                );
            }
        }

        // Get CI type and build status
        let ciType = null;
        let branchBuildStatus = null;
        let tagBuildStatus = null;

        if (ciService && hasRemote) {
            ciType = gitService.detectCIType();
            
            if (ciType && currentBranch) {
                try {
                    branchBuildStatus = await ciService.getBuildStatus(currentBranch, ciType, false, forceRefresh);
                } catch (error) {
                    Logger.log(`Error fetching branch build status: ${error}`, "WARNING");
                }
                
                if (latestTag?.latest) {
                    try {
                        tagBuildStatus = await ciService.getBuildStatus(latestTag.latest, ciType, true, forceRefresh);
                    } catch (error) {
                        Logger.log(`Error fetching tag build status: ${error}`, "WARNING");
                    }
                }
            }
        }

        return {
            repoRoot,
            currentBranch,
            defaultBranch,
            latestTag,
            unreleasedCount,
            unmergedCount,
            ownerAndRepo: ownerAndRepo || null,
            hasRemote,
            branchBuildStatus,
            tagBuildStatus,
            ciType
        };
    }
    
    public stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = undefined;
        }
    }
} 