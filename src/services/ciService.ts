import * as vscode from 'vscode';
import axios, { AxiosError, AxiosResponse } from 'axios';

interface CIProvider {
  token: string;
  apiUrl: string;
}

interface BuildStatusCacheEntry {
  status: string;
  url: string;
  message?: string;
  timestamp: number;
}

export class CIService {
  private providers: { [key: string]: CIProvider };
  private buildStatusCache: { [key: string]: { [key: string]: BuildStatusCacheEntry } } = {};
  private defaultCacheTTL = 60000; // 1 minute cache TTL for most statuses
  private inProgressCacheTTL = 5000; // 5 seconds cache TTL for in-progress statuses
  private cacheBypassTimeout: { [key: string]: number } = {};
  private rateLimitWarningThreshold = 0.95; // Warn when 95% of the rate limit is used

  constructor() {
    this.providers = this.loadProviders();
  }

  private loadProviders(): { [key: string]: CIProvider } {
    const config = vscode.workspace.getConfiguration('gitTagReleaseTracker');
    const ciProviders = config.get<{ [key: string]: CIProvider }>('ciProviders', {});
    
    console.log('CI Providers loaded:', Object.keys(ciProviders));
    
    return ciProviders;
  }

  async getBuildStatus(ref: string, owner: string, repo: string, ciType: 'github' | 'gitlab', isTag: boolean): Promise<{ status: string, url: string, message?: string }> {
    console.log('getBuildStatus called with:', { ref, owner, repo, ciType, isTag });

    const repoKey = `${owner}/${repo}`;
    const cacheKey = `${ref}/${ciType}`;

    if (!this.buildStatusCache[repoKey]) {
      this.buildStatusCache[repoKey] = {};
    }

    const cachedResult = this.buildStatusCache[repoKey][cacheKey];

    // Check if we should bypass the cache
    if (this.cacheBypassTimeout[cacheKey] && Date.now() < this.cacheBypassTimeout[cacheKey]) {
      console.log('Bypassing cache for recent push');
      return this.fetchFreshBuildStatus(ref, owner, repo, ciType, isTag);
    }

    if (cachedResult) {
      const isInProgress = ['pending', 'in_progress', 'queued', 'requested', 'waiting'].includes(cachedResult.status);
      const cacheTTL = isInProgress ? this.inProgressCacheTTL : this.defaultCacheTTL;

      if (Date.now() - cachedResult.timestamp < cacheTTL) {
        console.log('Returning cached build status');
        return {
          status: cachedResult.status,
          url: cachedResult.url,
          message: cachedResult.message
        };
      }
    }

    return this.fetchFreshBuildStatus(ref, owner, repo, ciType, isTag);
  }

  private async fetchFreshBuildStatus(ref: string, owner: string, repo: string, ciType: 'github' | 'gitlab', isTag: boolean): Promise<{ status: string, url: string, message?: string }> {
    console.log(`Fetching fresh build status for ${ref} (${owner}/${repo}) using ${ciType}`);

    const provider = this.providers[ciType];
    if (!provider || !provider.token || !provider.apiUrl) {
      console.error(`CI Provider ${ciType} is not properly configured.`);
      return { status: 'unknown', url: '', message: `CI Provider ${ciType} is not properly configured.` };
    }

    if (!owner || !repo) {
      console.error('Owner or repo is not provided:', { owner, repo });
      return { status: 'unknown', url: '', message: 'Unable to determine owner and repo.' };
    }

    try {
      let result;
      if (ciType === 'github') {
        result = await this.getGitHubBuildStatus(ref, owner, repo, provider, isTag);
      } else if (ciType === 'gitlab') {
        result = await this.getGitLabBuildStatus(ref, owner, repo, provider, isTag);
      } else {
        throw new Error('Unsupported CI type');
      }

      console.log(`Fetched build status:`, result);

      // Check rate limit after successful API call
      this.checkRateLimit(result.response, ciType);

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
    } catch (error) {
      console.error('Error fetching build status:', error);
      let message = 'An error occurred while fetching the build status.';
      if (error instanceof AxiosError && error.response?.status === 401) {
        message = 'Authentication failed. Please check your CI token in the settings.';
      }
      return { 
        status: 'error', 
        url: ciType === 'github' 
          ? `https://github.com/${owner}/${repo}/actions`
          : `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
        message
      };
    }
  }

  private async getGitHubBuildStatus(ref: string, owner: string, repo: string, provider: CIProvider, isTag: boolean): Promise<{ status: string, url: string, message?: string, response: AxiosResponse }> {
    const runsUrl = `${provider.apiUrl}/repos/${owner}/${repo}/actions/runs`;
    console.log(`Fetching workflow runs for ${ref} from:`, runsUrl);

    try {
      const runsResponse = await axios.get(runsUrl, {
        headers: {
          Authorization: `Bearer ${provider.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        params: {
          per_page: 30, // Fetch more runs to ensure we catch the relevant one
          exclude_pull_requests: true
        }
      });

      console.log('Runs response:', runsResponse.data);

      // Filter runs based on whether ref is a branch or a tag
      const relevantRuns = runsResponse.data.workflow_runs.filter((run: any) => 
        isTag ? run.head_commit.id === ref || run.head_branch === ref
              : run.head_branch === ref
      );

      if (relevantRuns.length === 0) {
        console.log(`No relevant workflow runs found for ${ref}`);
        return { 
          status: 'no_runs', 
          url: `https://github.com/${owner}/${repo}/actions`,
          message: `No relevant workflow runs found for ${isTag ? 'tag' : 'branch'} ${ref}`,
          response: runsResponse
        };
      }

      const latestRun = relevantRuns[0];
      const status = latestRun.status;
      const conclusion = latestRun.conclusion;

      // Determine the final status based on both status and conclusion
      let finalStatus = status;
      if (status === 'completed') {
        finalStatus = conclusion || 'unknown';
      }

      console.log(`GitHub CI returning status: ${status}, conclusion: ${conclusion}, final status: ${finalStatus} for ${isTag ? 'tag' : 'branch'} ${ref}`);
      return { 
        status: finalStatus,
        url: latestRun.html_url,
        message: `GitHub CI returning status: ${finalStatus} for ${isTag ? 'tag' : 'branch'} ${ref}`,
        response: runsResponse
      };
    } catch (error) {
      console.error('Error fetching GitHub workflow runs:', error);
      return {
        status: 'error',
        url: `https://github.com/${owner}/${repo}/actions`,
        message: `Error fetching workflow runs for ${ref}`,
        response: {} as AxiosResponse
      };
    }
  }

  private async getGitLabBuildStatus(ref: string, owner: string, repo: string, provider: CIProvider, isTag: boolean): Promise<{ status: string, url: string, message?: string, response: AxiosResponse }> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const pipelinesUrl = `${provider.apiUrl}/api/v4/projects/${projectId}/pipelines`;
    console.log('Fetching pipelines from:', pipelinesUrl);

    try {
      const pipelinesResponse = await axios.get(pipelinesUrl, {
        headers: {
          'PRIVATE-TOKEN': provider.token
        },
        params: {
          ref: ref,
          order_by: 'id',
          sort: 'desc',
          per_page: 1
        }
      });

      console.log('Pipelines response:', pipelinesResponse.data);

      if (pipelinesResponse.data.length === 0) {
        console.log(`No pipelines found for ${isTag ? 'tag' : 'branch'}: ${ref}`);
        return { 
          status: 'no_runs', 
          url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
          message: `No pipelines found for ${isTag ? 'tag' : 'branch'} ${ref}`,
          response: pipelinesResponse
        };
      }

      const latestPipeline = pipelinesResponse.data[0];
      
      // Check if the pipeline's ref matches the requested ref
      if (latestPipeline.ref !== ref) {
        console.log(`No matching pipeline found for ${isTag ? 'tag' : 'branch'}: ${ref}`);
        return { 
          status: 'no_runs', 
          url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
          message: `No matching pipeline found for ${isTag ? 'tag' : 'branch'} ${ref}`,
          response: pipelinesResponse
        };
      }

      const status = this.mapGitLabStatus(latestPipeline.status);
      const pipelineId = latestPipeline.id || 'latest';
      console.log(`GitLab CI returning status: ${status} for ${isTag ? 'tag' : 'branch'}: ${ref}`);
      return { 
        status: status,
        url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines/${pipelineId}`,
        message: `GitLab CI returning status: ${status} for ${isTag ? 'tag' : 'branch'} ${ref}`,
        response: pipelinesResponse
      };
    } catch (error) {
      console.error('Error fetching GitLab pipelines:', error);
      return {
        status: 'error',
        url: `${provider.apiUrl}/${owner}/${repo}/-/pipelines`,
        message: `Error fetching pipelines for ${isTag ? 'tag' : 'branch'} ${ref}`,
        response: {} as AxiosResponse
      };
    }
  }

  private mapGitLabStatus(gitlabStatus: string): string {
    switch (gitlabStatus) {
      case 'success': return 'success';
      case 'failed': return 'failure';
      case 'canceled': return 'cancelled';
      case 'skipped': return 'skipped';
      case 'running': return 'in_progress';
      case 'pending': return 'pending';
      case 'created': return 'queued';
      case 'manual': return 'action_required';
      default: return 'unknown';
    }
  }

  clearCache() {
    this.buildStatusCache = {};
  }

  clearCacheForRepo(owner: string, repo: string) {
    const repoKey = `${owner}/${repo}`;
    delete this.buildStatusCache[repoKey];
  }

  clearCacheForBranch(branch: string, owner: string, repo: string, ciType: 'github' | 'gitlab') {
    const repoKey = `${owner}/${repo}`;
    const cacheKey = `${branch}/${ciType}`;
    delete this.buildStatusCache[repoKey][cacheKey];
    
    // Set a timeout to bypass cache for this branch for the next 2 minutes
    this.cacheBypassTimeout[cacheKey] = Date.now() + 120000; // 2 minutes
  }

  async getImmediateBuildStatus(ref: string, owner: string, repo: string, ciType: 'github' | 'gitlab', isTag: boolean): Promise<{ status: string, url: string, message?: string }> {
    console.log('Immediate build status check for:', { ref, owner, repo, ciType, isTag });
    const result = await this.fetchFreshBuildStatus(ref, owner, repo, ciType, isTag);
    
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

  private checkRateLimit(response: AxiosResponse, ciType: 'github' | 'gitlab') {
    const headers = response.headers;
    let limit: number, remaining: number, reset: string | number;

    console.log(`Checking rate limit for ${ciType}`);
    console.log(`Response headers:`, headers);

    if (ciType === 'github') {
      limit = parseInt(headers['x-ratelimit-limit'] || '0');
      remaining = parseInt(headers['x-ratelimit-remaining'] || '0');
      reset = new Date(parseInt(headers['x-ratelimit-reset'] || '0') * 1000).toLocaleTimeString();
    } else if (ciType === 'gitlab') {
      limit = parseInt(headers['ratelimit-limit'] || '0');
      remaining = parseInt(headers['ratelimit-remaining'] || '0');
      reset = headers['ratelimit-reset'] || 'unknown';
    } else {
      console.log(`Unknown CI type: ${ciType}, skipping rate limit check`);
      return;
    }

    console.log(`Rate limit info - Limit: ${limit}, Remaining: ${remaining}, Reset: ${reset}`);

    if (limit > 0) {
      const usagePercentage = (limit - remaining) / limit;
      console.log(`Usage percentage: ${(usagePercentage * 100).toFixed(1)}%`);
      
      if (usagePercentage >= this.rateLimitWarningThreshold) {
        const warningMessage = `${ciType.toUpperCase()} API rate limit is at ${(usagePercentage * 100).toFixed(1)}%. Limit resets at ${reset}. Please be cautious with further requests.`;
        console.log(`Showing warning: ${warningMessage}`);
        vscode.window.showWarningMessage(warningMessage);
      } else {
        console.log(`Usage below warning threshold`);
      }
    } else {
      console.log(`Invalid rate limit value: ${limit}`);
    }
  }
}