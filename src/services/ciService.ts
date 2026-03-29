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

interface CachedBuildStatus extends BuildStatus {
  timestamp: number;
}

interface RateLimitState {
  cooldownUntil?: number;
  lastWarningResetAt?: number;
}

export class CIService {
  private providers: {[key: string]: CIProvider};
  private buildStatusCache: {
    [repoKey: string]: {
      [cacheKey: string]: CachedBuildStatus;
    };
  } = {};
  private static rateLimitState: Partial<Record<"github" | "gitlab", RateLimitState>> = {};
  private readonly rateLimitWarningThreshold = 0.95;
  private readonly rateLimitCooldownThreshold = 0.99;
  private readonly minimumRemainingBeforeCooldown = 25;
  private readonly defaultRateLimitCooldownMs = 5 * 60 * 1000;
  private readonly requestTimeoutMs = 12000;
  private readonly transientRetryDelayMs = 750;
  private readonly maxTransientRetryAttempts = 2;
  private readonly inProgressStatuses = ["pending", "in_progress", "queued", "requested", "waiting", "running"];
  private readonly inProgressCacheDuration = 10000; // 10 seconds
  private readonly cacheDuration = 60000; // 1 minute cache

  constructor(
    private owner: string,
    private repo: string
  ) {
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
    const cachedResult = this.getCachedResult(repoKey, cacheKey);

    if (cachedResult && !forceRefresh) {
      const cacheAge = now - cachedResult.timestamp;
      const isInProgress = this.inProgressStatuses.includes(cachedResult.status);
      const validCacheDuration = isInProgress ? this.inProgressCacheDuration : this.cacheDuration;

      if (cacheAge < validCacheDuration) {
        Logger.log(`Returning cached build status for ${ref} (${this.owner}/${this.repo})`, "INFO");
        return this.toBuildStatus(cachedResult);
      }
    }

    const cooldownUntil = this.getActiveCooldown(ciType, now);
    if (cooldownUntil) {
      Logger.log(
        `Skipping fresh ${ciType} build status fetch for ${ref} (${this.owner}/${this.repo}) until ${this.formatResetTime(cooldownUntil)}`,
        "WARNING"
      );

      if (cachedResult) {
        return this.toBuildStatus(cachedResult);
      }

      return {
        status: "unknown",
        url: "",
        icon: this.getStatusIcon("unknown"),
        message: `Skipping ${ciType} build status checks until ${this.formatResetTime(cooldownUntil)} to reduce API pressure.`
      };
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

      result.icon = this.getStatusIcon(result.status);

      // Check rate limit after successful API call, only if headers are available
      if (result.response?.headers) {
        this.checkRateLimit(result.response.headers, ciType);
      }

      this.cacheResult(ref, ciType, result);

      return result;
    } catch (error) {
      const errorResult = this.handleFetchError(error, ciType);

      if (this.isRateLimitError(error, ciType) && cachedResult) {
        Logger.log(
          `Returning cached build status for ${ref} (${this.owner}/${this.repo}) after ${ciType} rate limiting`,
          "WARNING"
        );
        return this.toBuildStatus(cachedResult);
      }

      errorResult.icon = this.getStatusIcon(errorResult.status);
      return errorResult;
    }
  }

  private async getGitHubBuildStatus(ref: string, provider: CIProvider, isTag: boolean): Promise<BuildStatus> {
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
      const runsResponse = await this.requestWithRetry(
        () =>
          axios.get(runsUrl, {
            headers: {
              Authorization: `Bearer ${provider.token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28"
            },
            params: {
              branch: ref,
              per_page: 20,
              exclude_pull_requests: true
            },
            timeout: this.requestTimeoutMs
          }),
        "github",
        `${isTag ? "tag" : "branch"} ${ref}`
      );

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
      throw error;
    }
  }

  private async getGitLabBuildStatus(ref: string, provider: CIProvider, isTag: boolean): Promise<BuildStatus> {
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
      const pipelinesResponse = await this.requestWithRetry(
        () =>
          axios.get(pipelinesUrl, {
            headers: {"PRIVATE-TOKEN": provider.token},
            params: {
              ref: ref,
              order_by: "id",
              sort: "desc",
              per_page: 1
            },
            timeout: this.requestTimeoutMs
          }),
        "gitlab",
        `${isTag ? "tag" : "branch"} ${ref}`
      );

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
      throw error;
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

  async getImmediateBuildStatus(ref: string, ciType: "github" | "gitlab", isTag: boolean): Promise<BuildStatus> {
    Logger.log(`Immediately fetching build status for ${ref} (${this.owner}/${this.repo})`, "INFO");
    const result = await this.getBuildStatus(ref, ciType, isTag, true);
    return result || {status: "unknown", url: "", message: "Unable to fetch immediate build status."};
  }

  private async requestWithRetry<T>(
    requestFactory: () => Promise<AxiosResponse<T>>,
    ciType: "github" | "gitlab",
    requestContext: string
  ): Promise<AxiosResponse<T>> {
    let retryAttempt = 0;

    while (true) {
      try {
        return await requestFactory();
      } catch (error) {
        if (!this.isTransientNetworkError(error) || retryAttempt >= this.maxTransientRetryAttempts) {
          throw error;
        }

        retryAttempt += 1;
        const delayMs = this.transientRetryDelayMs * retryAttempt;
        Logger.log(
          `Transient ${ciType} network issue while fetching ${requestContext} for ${this.owner}/${this.repo}; retrying in ${delayMs}ms (${retryAttempt}/${this.maxTransientRetryAttempts})`,
          "WARNING"
        );
        await this.delay(delayMs);
      }
    }
  }

  private async delay(delayMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  private getCachedResult(repoKey: string, cacheKey: string): CachedBuildStatus | undefined {
    return this.buildStatusCache[repoKey]?.[cacheKey];
  }

  private toBuildStatus(cachedResult: CachedBuildStatus): BuildStatus {
    const {timestamp, ...result} = cachedResult;
    return {...result};
  }

  private getActiveCooldown(ciType: "github" | "gitlab", now: number): number | undefined {
    const state = CIService.rateLimitState[ciType];
    if (!state?.cooldownUntil) {
      return undefined;
    }

    if (state.cooldownUntil <= now) {
      delete state.cooldownUntil;
      return undefined;
    }

    return state.cooldownUntil;
  }

  private activateRateLimitCooldown(ciType: "github" | "gitlab", headers?: any, reason?: string): number {
    const resetAt = this.getRateLimitResetTimestamp(headers, ciType) ?? Date.now() + this.defaultRateLimitCooldownMs;
    const state = CIService.rateLimitState[ciType] ?? {};

    if (!state.cooldownUntil || resetAt > state.cooldownUntil) {
      state.cooldownUntil = resetAt;
      CIService.rateLimitState[ciType] = state;
      Logger.log(
        `Entering ${ciType} API cooldown until ${this.formatResetTime(resetAt)}${reason ? `: ${reason}` : ""}`,
        "WARNING"
      );
    }

    return state.cooldownUntil ?? resetAt;
  }

  private getRateLimitResetTimestamp(headers: any, ciType: "github" | "gitlab"): number | undefined {
    if (!headers) {
      return undefined;
    }

    const rawReset = ciType === "github" ? headers["x-ratelimit-reset"] : headers["ratelimit-reset"];
    const parsedReset = Number.parseInt(String(rawReset ?? ""), 10);

    if (!Number.isFinite(parsedReset) || parsedReset <= 0) {
      return undefined;
    }

    if (ciType === "github" || parsedReset > 1_000_000_000) {
      return parsedReset * 1000;
    }

    return Date.now() + parsedReset * 1000;
  }

  private formatResetTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  private isRateLimitResponse(response: AxiosResponse, ciType: "github" | "gitlab"): boolean {
    if (response.status === 429) {
      return true;
    }

    if (response.status !== 403) {
      return false;
    }

    const remainingHeader =
      ciType === "github" ? response.headers?.["x-ratelimit-remaining"] : response.headers?.["ratelimit-remaining"];
    const remaining = Number.parseInt(String(remainingHeader ?? ""), 10);
    const responseText = this.getResponseText(response.data);

    return remaining === 0 || responseText.includes("rate limit");
  }

  private isRateLimitError(error: unknown, ciType: "github" | "gitlab"): boolean {
    return axios.isAxiosError(error) && !!error.response && this.isRateLimitResponse(error.response, ciType);
  }

  private isTransientNetworkError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error && this.isTransientNetworkMessage(error.message);
    }

    if (error.response) {
      return false;
    }

    const errorCode = String((error as AxiosError).code ?? "").toUpperCase();
    return (
      ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(errorCode) ||
      this.isTransientNetworkMessage(error.message)
    );
  }

  private isTransientNetworkMessage(message: string): boolean {
    const normalizedMessage = message.toLowerCase();
    return (
      normalizedMessage.includes("socket hang up") ||
      normalizedMessage.includes("econnreset") ||
      normalizedMessage.includes("etimedout") ||
      normalizedMessage.includes("timeout") ||
      normalizedMessage.includes("eai_again")
    );
  }

  private getResponseText(data: unknown): string {
    if (typeof data === "string") {
      return data.toLowerCase();
    }

    if (data && typeof data === "object" && "message" in data) {
      return String((data as {message?: unknown}).message ?? "").toLowerCase();
    }

    return JSON.stringify(data).toLowerCase();
  }

  private getRateLimitInfo(headers: any, ciType: "github" | "gitlab") {
    const limitHeader = ciType === "github" ? headers["x-ratelimit-limit"] : headers["ratelimit-limit"];
    const remainingHeader = ciType === "github" ? headers["x-ratelimit-remaining"] : headers["ratelimit-remaining"];
    const limit = Number.parseInt(String(limitHeader ?? "0"), 10);
    const remaining = Number.parseInt(String(remainingHeader ?? "0"), 10);
    const resetAt = this.getRateLimitResetTimestamp(headers, ciType);

    return {
      limit,
      remaining,
      resetAt
    };
  }

  private checkRateLimit(headers: any, ciType: "github" | "gitlab") {
    const {limit, remaining, resetAt} = this.getRateLimitInfo(headers, ciType);

    if (limit > 0) {
      const usagePercentage = (limit - remaining) / limit;
      Logger.log(
        `Rate limit for ${ciType}: ${usagePercentage.toFixed(1)}% used, ${remaining} remaining out of ${limit}.`,
        "INFO"
      );

      if (usagePercentage >= this.rateLimitWarningThreshold) {
        const warningKey = resetAt ?? -1;
        const state = CIService.rateLimitState[ciType] ?? {};

        if (state.lastWarningResetAt !== warningKey) {
          state.lastWarningResetAt = warningKey;
          CIService.rateLimitState[ciType] = state;

          const resetDisplay = resetAt ? this.formatResetTime(resetAt) : "unknown";
          const warningMessage = `${ciType} API rate limit is at ${(usagePercentage * 100).toFixed(
            1
          )}%. Limit resets at ${resetDisplay}. Please be cautious with further requests.`;
          vscode.window.showWarningMessage(warningMessage);
        }
      }

      if (usagePercentage >= this.rateLimitCooldownThreshold || remaining <= this.minimumRemainingBeforeCooldown) {
        this.activateRateLimitCooldown(ciType, headers, `remaining quota is low (${remaining}/${limit})`);
      }
    }
  }

  private cacheResult(ref: string, ciType: "github" | "gitlab", result: BuildStatus) {
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

  private handleFetchError(error: any, ciType: "github" | "gitlab" | null): BuildStatus {
    const repoKey = `${this.owner}/${this.repo}`;
    let message = `Failed to fetch build status from ${ciType}.`;
    let severity: "WARNING" | "ERROR" = "ERROR";
    let status = "error";
    const isTransientNetworkIssue = this.isTransientNetworkError(error);

    if (axios.isAxiosError(error)) {
      const {response} = error as AxiosError;
      if (response) {
        const {status, data} = response;
        message = `API request failed with status ${status}: ${JSON.stringify(data)}`;

        if (ciType && this.isRateLimitResponse(response, ciType)) {
          const cooldownUntil = this.activateRateLimitCooldown(
            ciType,
            response.headers,
            "received a rate-limited response"
          );
          message = `Rate limit exceeded for ${ciType}. Using cached data when available until ${this.formatResetTime(cooldownUntil)}.`;
        } else if (status === 401) {
          message = "Authentication failed. Please check your CI token.";
        } else if (status === 403) {
          message = "Permission denied. Please check your CI token and repository permissions.";
        } else if (status === 404) {
          message = "Resource not found. Please check your repository path and CI configuration.";
        } else if (status === 429) {
          message = "Rate limit exceeded. Please try again later.";
        }
      } else {
        if (isTransientNetworkIssue) {
          const providerName = ciType === "gitlab" ? "GitLab" : "GitHub";
          message = `Temporary network issue while contacting ${providerName}. The extension will retry automatically.`;
          severity = "WARNING";
          status = "unknown";
        } else {
          message = `Network error: ${error.message}`;
        }
      }
    } else if (error instanceof Error) {
      if (isTransientNetworkIssue) {
        const providerName = ciType === "gitlab" ? "GitLab" : "GitHub";
        message = `Temporary network issue while contacting ${providerName}. The extension will retry automatically.`;
        severity = "WARNING";
        status = "unknown";
      } else {
        message = `An unexpected error occurred: ${error.message}`;
      }
    }

    Logger.log(`${message} for repository ${repoKey}`, severity);
    return {
      status,
      url: undefined,
      message
    };
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

  public getCompareUrl(from: string, to: string, ciType: "github" | "gitlab"): BuildStatus {
    // Remove 'origin/' prefix from branch names for proper URL generation
    const cleanFrom = from.replace(/^origin\//, "");
    const cleanTo = to.replace(/^origin\//, "");

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
