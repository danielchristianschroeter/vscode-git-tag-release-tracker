import {GitService, TagResult} from "./gitService";
import {RepositoryServices} from "../globals";
import {Logger} from "../utils/logger";
import {BuildStatus, CIService} from "./ciService";
import {globals} from "../globals";

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
  private pollState: Map<string, {consecutiveInProgressPolls: number; nextPollAt: number}> = new Map();
  private readonly basePollingIntervalMs = 15000;
  private readonly maxPollingIntervalMs = 60000;
  private readonly repoDataConcurrencyLimit = 2;

  constructor(private repositoryServices: Map<string, RepositoryServices>) {
    this.startPolling();
  }

  public async getAggregatedData(forceRefresh: boolean = false): Promise<AggregatedData> {
    if (forceRefresh) {
      this.clearCache();
    }

    const sortedRepos = Array.from(this.repositoryServices.entries()).sort(([pathA], [pathB]) =>
      pathA.toLowerCase().localeCompare(pathB.toLowerCase())
    );

    const repoDataList = await this.collectRepoData(sortedRepos, forceRefresh);

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
          data.branchBuildStatus.status = "loading";
          data.branchBuildStatus.icon = "$(sync~spin)";
        }
        if (data.tagBuildStatus) {
          data.tagBuildStatus.status = "loading";
          data.tagBuildStatus.icon = "$(sync~spin)";
        }
        this.cache.set(repoRoot, data);
        // Trigger a UI update (full refresh) to recompute commit counts and fetch CI status
        globals.statusBarService?.triggerUpdate(true);
      }
      Logger.log(`Cache invalidated for ${repoRoot}`, "INFO");
    }
  }

  public getRepoDataForRoot(repoRoot: string): RepoData | undefined {
    return this.cache.get(repoRoot);
  }

  public clearCache() {
    this.cache.clear();
    this.pollState.clear();
    Logger.log("Cleared all repository data cache.", "INFO");
  }

  private startPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.pollingInterval = setInterval(async () => {
      await this.pollInProgressBuilds();
    }, this.basePollingIntervalMs); // Poll every 15 seconds
  }

  private async pollInProgressBuilds() {
    let needsUpdate = false;
    const now = Date.now();

    for (const [repoRoot, data] of this.cache.entries()) {
      const services = this.repositoryServices.get(repoRoot);
      if (!services || !services.ciService || !data.ciType) {
        continue;
      }

      const ciService = services.ciService as CIService;

      const pollTasks: Promise<void>[] = [];

      if (
        data.branchBuildStatus &&
        data.currentBranch &&
        ciService.isInProgressStatus(data.branchBuildStatus.status) &&
        this.shouldPollBuild(repoRoot, data.currentBranch, false, now)
      ) {
        pollTasks.push(
          this.updateBuildStatusInternal(ciService, data, false).then(updated => {
            if (updated) {
              needsUpdate = true;
            }
          })
        );
      }
      if (
        data.tagBuildStatus &&
        data.latestTag?.latest &&
        ciService.isInProgressStatus(data.tagBuildStatus.status) &&
        this.shouldPollBuild(repoRoot, data.latestTag.latest, true, now)
      ) {
        pollTasks.push(
          this.updateBuildStatusInternal(ciService, data, true).then(updated => {
            if (updated) {
              needsUpdate = true;
            }
          })
        );
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
    this.updatePollState(data.repoRoot, ref, isTag, newStatus?.status, ciService);

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

  private shouldPollBuild(repoRoot: string, ref: string, isTag: boolean, now: number): boolean {
    const state = this.pollState.get(this.getPollKey(repoRoot, ref, isTag));
    return !state || now >= state.nextPollAt;
  }

  private updatePollState(
    repoRoot: string,
    ref: string,
    isTag: boolean,
    status: string | undefined,
    ciService: CIService
  ) {
    const pollKey = this.getPollKey(repoRoot, ref, isTag);

    if (!status || !ciService.isInProgressStatus(status)) {
      this.pollState.delete(pollKey);
      return;
    }

    const previousState = this.pollState.get(pollKey);
    const consecutiveInProgressPolls = (previousState?.consecutiveInProgressPolls ?? 0) + 1;
    const nextPollAt = Date.now() + this.getPollingDelay(consecutiveInProgressPolls);

    this.pollState.set(pollKey, {
      consecutiveInProgressPolls,
      nextPollAt
    });
  }

  private getPollingDelay(consecutiveInProgressPolls: number): number {
    return Math.min(
      this.basePollingIntervalMs * Math.pow(2, Math.max(consecutiveInProgressPolls - 1, 0)),
      this.maxPollingIntervalMs
    );
  }

  private getPollKey(repoRoot: string, ref: string, isTag: boolean): string {
    return `${repoRoot}:${isTag ? "tag" : "branch"}:${ref}`;
  }

  private async collectRepoData(
    sortedRepos: Array<[string, RepositoryServices]>,
    forceRefresh: boolean
  ): Promise<RepoData[]> {
    if (sortedRepos.length === 0) {
      return [];
    }

    const results: RepoData[] = new Array(sortedRepos.length);
    let nextIndex = 0;
    const workerCount = Math.min(this.repoDataConcurrencyLimit, sortedRepos.length);

    await Promise.all(
      Array.from({length: workerCount}, async () => {
        while (nextIndex < sortedRepos.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;

          const [repoRoot, services] = sortedRepos[currentIndex];
          results[currentIndex] =
            this.cache.has(repoRoot) && !forceRefresh
              ? this.cache.get(repoRoot)!
              : await this.getRepoData(repoRoot, services.gitService, services.ciService, forceRefresh);
        }
      })
    );

    return results;
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
        unreleasedCount = await gitService.getCommitCounts(latestTag.latest, defaultBranch, forceRefresh);
      } else if (isDefaultBranch && currentBranch) {
        // If no tags exist and we're on default branch, count all commits
        unreleasedCount = await gitService.getCommitCounts(null, currentBranch, forceRefresh);
      }

      // Calculate unmerged commits when not on default branch
      if (!isDefaultBranch && currentBranch) {
        unmergedCount = await gitService.getCommitCounts(defaultBranch, currentBranch, forceRefresh);
      }
    }

    // Get CI type and build status
    let ciType = null;
    let branchBuildStatus = null;
    let tagBuildStatus = null;

    if (ciService && hasRemote) {
      ciType = gitService.detectCIType();

      if (ciType && currentBranch) {
        const branchBuildStatusPromise = this.fetchBuildStatusSafe(
          ciService,
          currentBranch,
          ciType,
          false,
          forceRefresh,
          "branch"
        );
        const tagBuildStatusPromise = latestTag?.latest
          ? this.fetchBuildStatusSafe(ciService, latestTag.latest, ciType, true, forceRefresh, "tag")
          : Promise.resolve(null);

        [branchBuildStatus, tagBuildStatus] = await Promise.all([branchBuildStatusPromise, tagBuildStatusPromise]);
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

  private async fetchBuildStatusSafe(
    ciService: CIService,
    ref: string,
    ciType: "github" | "gitlab",
    isTag: boolean,
    forceRefresh: boolean,
    kind: "branch" | "tag"
  ): Promise<BuildStatus | null> {
    try {
      return await ciService.getBuildStatus(ref, ciType, isTag, forceRefresh);
    } catch (error) {
      Logger.log(`Error fetching ${kind} build status: ${error}`, "WARNING");
      return null;
    }
  }

  public stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }
}
