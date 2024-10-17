import * as vscode from "vscode";
import axios, {AxiosError, AxiosResponse} from "axios";
import {Logger} from "../utils/logger";

interface CIProvider {
  token: string;
  apiUrl: string;
}

export class CIService {
  private providers: {[key: string]: CIProvider};
  private buildStatusCache: {
    [repoKey: string]: {
      [cacheKey: string]: {
        status: string;
        url: string;
        message?: string;
        timestamp: number;
      };
    };
  } = {};
  private rateLimitWarningThreshold = 0.95;
  private inProgressStatuses = ["pending", "in_progress", "queued", "requested", "waiting", "running"];
  private inProgressCacheDuration = 10000; // 10 seconds
  private cacheDuration = 60000; // 1 minute cache

  constructor() {
    this.providers = this.loadProviders();
  }

  private loadProviders(): {[key: string]: CIProvider} {
    const config = vscode.workspace.getConfiguration("gitTagReleaseTracker");
    const ciProviders = config.get<{[key: string]: CIProvider}>("ciProviders", {});

    return ciProviders;
  }

  async getBuildStatus(
    ref: string,
    owner: string,
    repo: string,
    ciType: "github" | "gitlab",
    isTag: boolean,
    forceRefresh: boolean = false
  ): Promise<{status: string; url: string; message?: string} | null> {
    if (!ref) {
      Logger.log(`Skipping build status fetch due to empty ref for ${owner}/${repo}`, "INFO");
      return null;
    }

    const repoKey = `${owner}/${repo}`;
    const cacheKey = `${ref}/${ciType}`;
    const now = Date.now();

    if (!forceRefresh && this.buildStatusCache[repoKey] && this.buildStatusCache[repoKey][cacheKey]) {
      const cachedResult = this.buildStatusCache[repoKey][cacheKey];
      const cacheAge = now - cachedResult.timestamp;
      const isInProgress = this.inProgressStatuses.includes(cachedResult.status);
      const validCacheDuration = isInProgress ? this.inProgressCacheDuration : this.cacheDuration;

      if (cacheAge < validCacheDuration) {
        Logger.log(`Returning cached build status for ${ref} (${owner}/${repo})`, "INFO");
        return cachedResult;
      }
    }

    Logger.log(`Fetching fresh build status for ${ref} (${owner}/${repo}) using ${ciType}`, "INFO");
    try {
      const provider = this.providers[ciType];
      if (!provider || !provider.token || !provider.apiUrl) {
        Logger.log(`CI Provider ${ciType} is not properly configured.`, "WARNING");
        return {status: "unknown", url: "", message: `CI Provider ${ciType} is not properly configured.`};
      }

      if (!owner || !repo) {
        Logger.log("Owner or repo is not provided", "WARNING");
        return {status: "unknown", url: "", message: "Unable to determine owner and repo."};
      }

      let result: {status: string; url: string; message?: string; response?: {headers: any}};
      if (ciType === "github") {
        result = await this.getGitHubBuildStatus(ref, owner, repo, provider, isTag);
      } else if (ciType === "gitlab") {
        result = await this.getGitLabBuildStatus(ref, owner, repo, provider, isTag);
      } else {
        throw new Error("Unsupported CI type");
      }

      // Check rate limit after successful API call, only if headers are available
      if (result.response?.headers) {
        this.checkRateLimit(result.response.headers, ciType);
      }

      // Remove the 'response' property before caching and returning
      const {response, ...returnResult} = result;
      this.cacheResult(owner, repo, ref, ciType, returnResult);
      return returnResult;
    } catch (error) {
      return this.handleFetchError(error, owner, repo, ciType);
    }
  }

  private async getGitHubBuildStatus(
    ref: string,
    owner: string,
    repo: string,
    provider: CIProvider,
    isTag: boolean
  ): Promise<{status: string; url: string; message?: string; response?: {headers: any}}> {
    const runsUrl = `${provider.apiUrl}/repos/${owner}/${repo}/actions/runs`;
    Logger.log(`Fetching workflow runs for ${ref} from: ${runsUrl}`, "INFO");

    // If it's a tag and the ref is empty, return no_runs immediately
    if (isTag && !ref) {
      Logger.log("Empty tag provided, returning no_runs status", "INFO");
      return {
        status: "no_runs",
        url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
        message: "No tag provided"
      };
    }

    try {
      const runsResponse = await axios.get(runsUrl, {
        headers: {
          Authorization: `Bearer ${provider.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        params: {
          branch: ref,
          per_page: 30,
          exclude_pull_requests: true
        }
      });

      //console.log("GitLab API Response:", runsResponse.data);

      const runs = runsResponse.data.workflow_runs;
      const latestRun = runs.find((run: any) => run.head_branch === ref || run.head_sha === ref);

      if (!latestRun) {
        return {
          status: "no_runs",
          url: `https://github.com/${owner}/${repo}/actions`,
          message: `No workflow run found for ${isTag ? "tag" : "branch"} ${ref}`,
          response: {headers: runsResponse.headers}
        };
      }

      let status = latestRun.status;
      const conclusion = latestRun.conclusion;

      if (status === "completed") {
        status = conclusion === "success" ? "success" : "failure";
      }

      const finalStatus = status === "in_progress" ? "pending" : status;

      Logger.log(
        `GitHub CI returning status: ${status}, conclusion: ${conclusion}, final status: ${finalStatus} for ${
          isTag ? "tag" : "branch"
        } ${ref}`,
        "INFO"
      );
      return {
        status: finalStatus,
        url: latestRun.html_url,
        message: `GitHub CI returning status: ${finalStatus} for ${isTag ? "tag" : "branch"} ${ref}`,
        response: {headers: runsResponse.headers}
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        Logger.log(`No GitHub Actions found for ${owner}/${repo}`, "INFO");
        return {
          status: "no_runs",
          url: `https://github.com/${owner}/${repo}/actions`,
          message: `No GitHub Actions configured for ${owner}/${repo}`
        };
      }
      Logger.log(`Error fetching GitHub workflow runs: ${this.getErrorMessage(error)}`, "ERROR");
      return this.handleFetchError(error, owner, repo, "github");
    }
  }

  private async getGitLabBuildStatus(
    ref: string,
    owner: string,
    repo: string,
    provider: CIProvider,
    isTag: boolean
  ): Promise<{status: string; url: string; message?: string; response?: {headers: any}}> {
    // Ensure the API URL includes the /api/v4 path
    const apiUrl = provider.apiUrl.endsWith("/api/v4") ? provider.apiUrl : `${provider.apiUrl}/api/v4`;
    const pipelinesUrl = `${apiUrl}/projects/${encodeURIComponent(`${owner}/${repo}`)}/pipelines`;
    Logger.log(`Fetching pipelines for ${ref} from: ${pipelinesUrl}`, "INFO");

    // If it's a tag and the ref is empty, return no_runs immediately
    if (isTag && !ref) {
      Logger.log("Empty tag provided, returning no_runs status", "INFO");
      return {
        status: "no_runs",
        url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
        message: "No tag provided"
      };
    }

    try {
      const pipelinesResponse = await axios.get(pipelinesUrl, {
        headers: {"PRIVATE-TOKEN": provider.token},
        params: {
          ref: ref,
          order_by: "id",
          sort: "desc",
          per_page: 1
        }
      });

      //console.log("GitLab API Response:", pipelinesResponse.data);

      const pipelines = pipelinesResponse.data;

      if (pipelines.length === 0) {
        Logger.log(`No pipelines found for ${isTag ? "tag" : "branch"} ${ref}`, "INFO");
        return {
          status: "no_runs",
          url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
          message: `No pipeline found for ${isTag ? "tag" : "branch"} ${ref}`,
          response: {headers: pipelinesResponse.headers}
        };
      }

      const latestPipeline = pipelines[0];
      // Check if the returned pipeline matches the requested ref
      if (latestPipeline.ref !== ref) {
        Logger.log(`Pipeline found but doesn't match the requested ref: ${ref}`, "INFO");
        return {
          status: "no_runs",
          url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
          message: `No pipeline found for ${isTag ? "tag" : "branch"} ${ref}`,
          response: {headers: pipelinesResponse.headers}
        };
      }

      let status = this.mapGitLabStatus(latestPipeline.status);

      Logger.log(`GitLab CI returning status: ${status} for ${isTag ? "tag" : "branch"} ${ref}`, "INFO");
      return {
        status: status,
        url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines/${latestPipeline.id}`,
        message: `GitLab CI returning status: ${status} for ${isTag ? "tag" : "branch"} ${ref}`,
        response: {headers: pipelinesResponse.headers}
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        Logger.log(`No GitLab Pipelines found for ${owner}/${repo}`, "INFO");
        return {
          status: "no_runs",
          url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
          message: `No GitLab Pipelines configured for ${owner}/${repo}`
        };
      }
      Logger.log(`Error fetching GitLab pipelines: ${this.getErrorMessage(error)}`, "ERROR");
      return this.handleFetchError(error, owner, repo, "gitlab");
    }
  }

  private mapGitLabStatus(gitlabStatus: string): string {
    switch (gitlabStatus) {
      case "success":
        return "success";
      case "failed":
        return "failure";
      case "canceled":
        return "cancelled";
      case "skipped":
        return "skipped";
      case "running":
        return "in_progress";
      case "pending":
        return "pending";
      case "created":
        return "queued";
      case "manual":
        return "action_required";
      default:
        return "unknown";
    }
  }

  clearCache() {
    this.buildStatusCache = {};
    Logger.log("CI Service cache cleared", "INFO");
  }

  clearCacheForRepo(owner: string, repo: string) {
    const repoKey = `${owner}/${repo}`;
    delete this.buildStatusCache[repoKey];
  }

  clearCacheForBranch(branch: string, owner: string, repo: string, ciType: "github" | "gitlab") {
    const repoKey = `${owner}/${repo}`;
    const cacheKey = `${branch}/${ciType}`;
    if (this.buildStatusCache[repoKey]) {
      delete this.buildStatusCache[repoKey][cacheKey];
    }
  }

  async getImmediateBuildStatus(
    ref: string,
    owner: string,
    repo: string,
    ciType: "github" | "gitlab",
    isTag: boolean
  ): Promise<{status: string; url: string; message?: string}> {
    const result = await this.getBuildStatus(ref, owner, repo, ciType, isTag, true);
    if (!result) {
      return {status: "unknown", url: "", message: "Unable to fetch build status"};
    }

    // Cache the result
    const repoKey = `${owner}/${repo}`;
    const cacheKey = `${ref}/${ciType}`;
    if (!this.buildStatusCache[repoKey]) {
      this.buildStatusCache[repoKey] = {};
    }
    this.buildStatusCache[repoKey][cacheKey] = {
      ...result,
      timestamp: Date.now()
    };

    return result;
  }

  private checkRateLimit(headers: any, ciType: "github" | "gitlab") {
    let limit: number, remaining: number, reset: string | number;

    if (ciType === "github") {
      limit = parseInt(headers["x-ratelimit-limit"] || "0");
      remaining = parseInt(headers["x-ratelimit-remaining"] || "0");
      reset = new Date(parseInt(headers["x-ratelimit-reset"] || "0") * 1000).toLocaleTimeString();
    } else if (ciType === "gitlab") {
      limit = parseInt(headers["ratelimit-limit"] || "0");
      remaining = parseInt(headers["ratelimit-remaining"] || "0");
      reset = headers["ratelimit-reset"] || "unknown";
    } else {
      Logger.log(`Unknown CI type: ${ciType}, skipping rate limit check`, "WARNING");
      return;
    }

    if (limit > 0) {
      const usagePercentage = (limit - remaining) / limit;
      Logger.log(
        `Rate limit for ${ciType}: ${usagePercentage.toFixed(1)}% used, ${remaining} remaining out of ${limit}.`,
        "INFO"
      );
      if (usagePercentage >= this.rateLimitWarningThreshold) {
        const warningMessage = `${ciType} API rate limit is at ${(usagePercentage * 100).toFixed(
          1
        )}%. Limit resets at ${reset}. Please be cautious with further requests.`;
        vscode.window.showWarningMessage(warningMessage);
      }
    }
  }

  private cacheResult(
    owner: string,
    repo: string,
    ref: string,
    ciType: string,
    result: {status: string; url: string; message?: string}
  ) {
    const repoKey = `${owner}/${repo}`;
    const cacheKey = `${ref}/${ciType}`;
    if (!this.buildStatusCache[repoKey]) {
      this.buildStatusCache[repoKey] = {};
    }
    this.buildStatusCache[repoKey][cacheKey] = {
      ...result,
      timestamp: Date.now()
    };
    Logger.log(`Cached build status for ${ref} (${owner}/${repo})`, "INFO");
  }

  private handleFetchError(
    error: unknown,
    owner: string,
    repo: string,
    ciType: string
  ): {status: string; url: string; message?: string} {
    let status = "unknown";
    let message: string | undefined;

    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        status = "error";
        message = "Authentication failed. Please check your CI token in the settings.";
      } else if (error.response?.status === 403) {
        status = "error";
        message = "Access forbidden. Please check your token permissions.";
      } else if (error.response?.status === 404) {
        status = "error";
        message = "Resource not found. Please check your repository path and CI configuration.";
      }
    }

    Logger.log(`Error fetching build status: ${this.getErrorMessage(error)}`, "WARNING");

    return {
      status: status,
      url:
        ciType === "github"
          ? `https://github.com/${owner}/${repo}/actions`
          : `${this.providers[ciType].apiUrl}/${owner}/${repo}/-/pipelines`,
      message: message
    };
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (error && typeof error === "object" && "message" in error) {
      return String(error.message);
    }
    return String(error);
  }

  public isInProgressStatus(status: string): boolean {
    return this.inProgressStatuses.includes(status);
  }

  public reloadProviders() {
    this.providers = this.loadProviders();
    Logger.log("CI Providers reloaded", "INFO");
  }
}
