import * as vscode from "vscode";
import axios, {AxiosError, AxiosResponse} from "axios";
import {Logger} from "../utils/logger";

export interface BuildStatus {
  status: string;
  url?: string;
  icon?: string;
  message?: string;
  response?: {
    headers: any;
  };
}

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
        url?: string;
        message?: string;
        timestamp: number;
      };
    };
  } = {};
  private rateLimitWarningThreshold = 0.95;
  private inProgressStatuses = ["pending", "in_progress", "queued", "requested", "waiting", "running"];
  private inProgressCacheDuration = 10000; // 10 seconds
  private cacheDuration = 60000; // 1 minute cache

  constructor(private owner: string, private repo: string) {
    this.providers = this.loadProviders();
  }

  private loadProviders(): {[key: string]: CIProvider} {
    const config = vscode.workspace.getConfiguration("gitTagReleaseTracker");
    const ciProviders = config.get<{[key: string]: CIProvider}>("ciProviders", {});

    return ciProviders;
  }

  async getBuildStatus(
    ref: string,
    ciType: "github" | "gitlab",
    isTag: boolean,
    forceRefresh: boolean = false
  ): Promise<BuildStatus | null> {
    if (!ref) {
      Logger.log(`Skipping build status fetch due to empty ref for ${this.owner}/${this.repo}`, "INFO");
      return null;
    }

    const repoKey = `${this.owner}/${this.repo}`;
    const cacheKey = `${ref}/${ciType}`;
    const now = Date.now();

    if (!forceRefresh && this.buildStatusCache[repoKey] && this.buildStatusCache[repoKey][cacheKey]) {
      const cachedResult = this.buildStatusCache[repoKey][cacheKey];
      const cacheAge = now - cachedResult.timestamp;
      const isInProgress = this.inProgressStatuses.includes(cachedResult.status);
      const validCacheDuration = isInProgress ? this.inProgressCacheDuration : this.cacheDuration;

      if (cacheAge < validCacheDuration) {
        Logger.log(`Returning cached build status for ${ref} (${this.owner}/${this.repo})`, "INFO");
        return cachedResult;
      }
    }

    Logger.log(`Fetching fresh build status for ${ref} (${this.owner}/${this.repo}) using ${ciType}`, "INFO");
    try {
      const provider = this.providers[ciType];
      if (!provider || !provider.token || !provider.apiUrl) {
        Logger.log(`CI Provider ${ciType} is not properly configured.`, "WARNING");
        return {status: "unknown", url: "", message: `CI Provider ${ciType} is not properly configured.`};
      }

      if (!this.owner || !this.repo) {
        Logger.log("Owner or repo is not provided", "WARNING");
        return {status: "unknown", url: "", message: "Unable to determine owner and repo."};
      }

      let result: BuildStatus;
      if (ciType === "github") {
        result = await this.getGitHubBuildStatus(ref, provider, isTag);
      } else if (ciType === "gitlab") {
        result = await this.getGitLabBuildStatus(ref, provider, isTag);
      } else {
        throw new Error("Unsupported CI type");
      }

      // Check rate limit after successful API call, only if headers are available
      if (result.response?.headers) {
        this.checkRateLimit(result.response.headers, ciType);
      }

      this.cacheResult(ref, ciType, result);
      
      // Add icon to result before returning
      result.icon = this.getStatusIcon(result.status);

      return result;
    } catch (error) {
      const errorResult = this.handleFetchError(error, ciType);
      errorResult.icon = this.getStatusIcon(errorResult.status);
      return errorResult;
    }
  }

  private async getGitHubBuildStatus(
    ref: string,
    provider: CIProvider,
    isTag: boolean
  ): Promise<BuildStatus> {
    const runsUrl = `${provider.apiUrl}/repos/${this.owner}/${this.repo}/actions/runs`;
    Logger.log(`Fetching workflow runs for ${ref} from: ${runsUrl}`, "INFO");

    // If it's a tag and the ref is empty, return no_runs immediately
    if (isTag && !ref) {
      Logger.log("Empty tag provided, returning no_runs status", "INFO");
      return {
        status: "no_runs",
        url: `${provider.apiUrl}/${this.owner}/${this.repo}/-/pipelines`,
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
          url: `https://github.com/${this.owner}/${this.repo}/actions`,
          message: `No workflow run found for ${isTag ? "tag" : "branch"} ${ref}`,
          response: {headers: runsResponse.headers}
        };
      }

      let status = latestRun.status;
      const conclusion = latestRun.conclusion;

      // Ensure the status is one of the allowed values
      if (status === "completed") {
        status = conclusion || "completed"; // Use conclusion if available
      }

      Logger.log(
        `GitHub CI returning status: ${status}, conclusion: ${conclusion} for ${isTag ? "tag" : "branch"} ${ref}`,
        "INFO"
      );
      return {
        status: status,
        url: latestRun.html_url,
        message: `GitHub CI returning status: ${status} for ${isTag ? "tag" : "branch"} ${ref}`,
        response: {headers: runsResponse.headers}
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        Logger.log(`No GitHub Actions found for ${this.owner}/${this.repo}`, "INFO");
        return {
          status: "no_runs",
          url: `https://github.com/${this.owner}/${this.repo}/actions`,
          message: `No GitHub Actions configured for ${this.owner}/${this.repo}`
        };
      }
      Logger.log(`Error fetching GitHub workflow runs: ${this.getErrorMessage(error, "github").message}`, "ERROR");
      return this.handleFetchError(error, "github");
    }
  }

  private async getGitLabBuildStatus(
    ref: string,
    provider: CIProvider,
    isTag: boolean
  ): Promise<BuildStatus> {
    // Ensure the API URL includes the /api/v4 path
    const apiUrl = provider.apiUrl.endsWith("/api/v4") ? provider.apiUrl : `${provider.apiUrl}/api/v4`;
    const pipelinesUrl = `${apiUrl}/projects/${encodeURIComponent(`${this.owner}/${this.repo}`)}/pipelines`;
    Logger.log(`Fetching pipelines for ${ref} from: ${pipelinesUrl}`, "INFO");

    // If it's a tag and the ref is empty, return no_runs immediately
    if (isTag && !ref) {
      Logger.log("Empty tag provided, returning no_runs status", "INFO");
      return {
        status: "no_runs",
        url: `${provider.apiUrl}/${this.owner}/${this.repo}/-/pipelines`,
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
          url: `${provider.apiUrl}/${this.owner}/${this.repo}/-/pipelines`,
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
          url: `${provider.apiUrl}/${this.owner}/${this.repo}/-/pipelines`,
          message: `No pipeline found for ${isTag ? "tag" : "branch"} ${ref}`,
          response: {headers: pipelinesResponse.headers}
        };
      }

      let status = this.mapGitLabStatus(latestPipeline.status);

      Logger.log(`GitLab CI returning status: ${status} for ${isTag ? "tag" : "branch"} ${ref}`, "INFO");
      return {
        status: status,
        url: `${provider.apiUrl}/${this.owner}/${this.repo}/-/pipelines/${latestPipeline.id}`,
        message: `GitLab CI returning status: ${status} for ${isTag ? "tag" : "branch"} ${ref}`,
        response: {headers: pipelinesResponse.headers}
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        Logger.log(`No GitLab pipelines found for ${this.owner}/${this.repo}`, "INFO");
        return {
          status: "no_runs",
          url: `https://gitlab.com/${this.owner}/${this.repo}/pipelines`,
          message: `No GitLab CI/CD configured for ${this.owner}/${this.repo}`
        };
      }
      Logger.log(`Error fetching GitLab pipelines: ${this.getErrorMessage(error, "gitlab").message}`, "ERROR");
      return this.handleFetchError(error, "gitlab");
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
    Logger.log("Cleared all CI build status caches", "INFO");
  }

  clearCacheForRepo() {
    const repoKey = `${this.owner}/${this.repo}`;
    if (this.buildStatusCache[repoKey]) {
      delete this.buildStatusCache[repoKey];
      Logger.log(`Cleared cache for repo: ${repoKey}`, "INFO");
    }
  }

  clearCacheForBranch(branch: string, ciType: "github" | "gitlab") {
    const repoKey = `${this.owner}/${this.repo}`;
    const cacheKey = `${branch}/${ciType}`;
    if (this.buildStatusCache[repoKey] && this.buildStatusCache[repoKey][cacheKey]) {
      delete this.buildStatusCache[repoKey][cacheKey];
      Logger.log(`Cleared cache for branch: ${branch} in repo: ${repoKey}`, "INFO");
    }
  }

  async getImmediateBuildStatus(
    ref: string,
    ciType: "github" | "gitlab",
    isTag: boolean
  ): Promise<BuildStatus> {
    Logger.log(`Immediately fetching build status for ${ref} (${this.owner}/${this.repo})`, "INFO");
    const result = await this.getBuildStatus(ref, ciType, isTag, true);
    return result || {status: "unknown", url: "", message: "Unable to fetch immediate build status."};
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
    ref: string,
    ciType: string,
    result: BuildStatus
  ) {
    const repoKey = `${this.owner}/${this.repo}`;
    if (!this.buildStatusCache[repoKey]) {
      this.buildStatusCache[repoKey] = {};
    }
    this.buildStatusCache[repoKey][`${ref}/${ciType}`] = {
      ...result,
      timestamp: Date.now()
    };
    Logger.log(`Cached build status for ${ref} (${repoKey})`, "INFO");
  }

  private handleFetchError(
    error: any,
    ciType: "github" | "gitlab" | null
  ): BuildStatus {
    const repoKey = `${this.owner}/${this.repo}`;
    let message = `Failed to fetch build status from ${ciType}.`;

    if (axios.isAxiosError(error)) {
      const {response} = error as AxiosError;
      if (response) {
        const {status, data} = response;
        message = `API request failed with status ${status}: ${JSON.stringify(data)}`;
        if (status === 401) {
          message = "Authentication failed. Please check your CI token.";
        } else if (status === 403) {
          message = "Permission denied. Please check your CI token and repository permissions.";
          this.checkRateLimit(response.headers, ciType as "github" | "gitlab");
        } else if (status === 404) {
          message = "Resource not found. Please check your repository path and CI configuration.";
        } else if (status === 429) {
          message = "Rate limit exceeded. Please try again later.";
        }
      } else {
        message = `Network error: ${error.message}`;
      }
    } else if (error instanceof Error) {
      message = `An unexpected error occurred: ${error.message}`;
    }

    Logger.log(`${message} for repository ${repoKey}`, "ERROR");
    return {
      status: "error",
      url: undefined,
      message
    };
  }

  private getErrorMessage(
    error: any,
    ciType: "github" | "gitlab" | null
  ): BuildStatus {
    const providerName = ciType === "github" ? "GitHub" : "GitLab";
    let message = `Failed to fetch status from ${providerName}.`;
    let status = "error";

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        const { status: httpStatus, data } = axiosError.response;
        message = `API error from ${providerName}: ${httpStatus} - ${JSON.stringify(data)}`;
        if (httpStatus === 401) {
          message = `Authentication failed for ${providerName}. Please check your token.`;
        } else if (httpStatus === 403) {
          message = `Forbidden. Check permissions for ${providerName} token.`;
        } else if (httpStatus === 404) {
          status = "no_runs";
          message = `No runs found for the specified reference in ${providerName}.`;
        }
      } else if (axiosError.request) {
        message = `No response received from ${providerName}. Check your network connection and the API URL.`;
      } else {
        message = `Error setting up request to ${providerName}: ${axiosError.message}`;
      }
    } else if (error instanceof Error) {
      message = `An unexpected error occurred: ${error.message}`;
    }

    return { status, message };
  }

  public isInProgressStatus(status: string): boolean {
    return this.inProgressStatuses.includes(status);
  }

  public getStatusIcon(status: string): string {
    switch (status) {
        case "success":
        case "completed":
            return "$(check)";
        case "failure":
        case "failed":
            return "$(x)";
        case "cancelled":
        case "canceled":
            return "$(circle-slash)";
        case "action_required":
        case "manual":
            return "$(alert)";
        case "in_progress":
        case "running":
            return "$(sync~spin)";
        case "loading":
            return "$(sync~spin)";
        case "queued":
        case "created":
        case "scheduled":
            return "$(clock)";
        case "requested":
        case "waiting":
        case "waiting_for_resource":
            return "$(watch)";
        case "pending":
        case "preparing":
            return "$(clock)";
        case "neutral":
            return "$(dash)";
        case "skipped":
            return "$(skip)";
        case "stale":
            return "$(history)";
        case "timed_out":
            return "$(clock)";
        default:
            return "$(question)";
    }
  }

  public reloadProviders() {
    this.providers = this.loadProviders();
    this.clearCache();
    Logger.log("CI providers reloaded.", "INFO");
  }

  public getCompareUrl(
    from: string,
    to: string,
    ciType: "github" | "gitlab"
  ): BuildStatus {
    // Remove 'origin/' prefix from branch names for proper URL generation
    const cleanFrom = from.replace(/^origin\//, '');
    const cleanTo = to.replace(/^origin\//, '');
    
    Logger.log(`Generating compare URL for ${cleanFrom}...${cleanTo} using ${ciType}`, "INFO");
    
    if (ciType === "github") {
      const url = `${this.getBaseUrl(ciType)}/compare/${cleanFrom}...${cleanTo}`;
      return {
        status: "success",
        url: url,
        message: `Compare URL for ${cleanFrom}...${cleanTo}`
      };
    } else if (ciType === "gitlab") {
      const url = `${this.getBaseUrl(ciType)}/-/compare/${cleanFrom}...${cleanTo}`;
      return {
        status: "success",
        url: url,
        message: `Compare URL for ${cleanFrom}...${cleanTo}`
      };
    } else {
      return {
        status: "error",
        url: undefined,
        message: `Unsupported CI type: ${ciType}`
      };
    }
  }

  private getBaseUrl(ciType: "github" | "gitlab"): string {
    const provider = this.providers[ciType];
    if (!provider) {
      Logger.log(`CI Provider ${ciType} is not configured.`, "WARNING");
      return "";
    }

    let baseUrl = provider.apiUrl;
    if (ciType === "github") {
      baseUrl = "https://github.com";
    } else if (ciType === "gitlab") {
      // Assuming GitLab apiUrl is the base web URL
      if (baseUrl.endsWith("/api/v4")) {
        baseUrl = baseUrl.slice(0, -7);
      }
    }

    if (!this.owner || !this.repo) {
      Logger.log("Owner or repo is not provided", "WARNING");
      return "";
    }

    return `${baseUrl}/${this.owner}/${this.repo}`;
  }
}
