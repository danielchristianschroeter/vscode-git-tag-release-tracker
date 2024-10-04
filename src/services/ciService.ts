import * as vscode from 'vscode';
import axios, { AxiosError } from 'axios';

export class CIService {
  private token: string;
  private apiUrl: string;

  constructor() {
    const config = vscode.workspace.getConfiguration('gitTagReleaseTracker');
    this.token = config.get<string>('ciToken', '');
    this.apiUrl = config.get<string>('ciApiUrl', '');
    
    console.log('CIService initialized:');
    console.log('API URL:', this.apiUrl);
    console.log('Token set:', !!this.token);
  }

  async getBuildStatus(tag: string, owner: string, repo: string, ciType?: 'github' | 'gitlab'): Promise<{ status: string, url: string, message?: string }> {
    console.log('getBuildStatus called with:', { tag, owner, repo, ciType });

    if (!this.token || !this.apiUrl) {
      console.error('CI Token or API URL is not set. Please check your settings.');
      return { status: 'unknown', url: '', message: 'CI Token or API URL is not set. Please check your settings.' };
    }

    if (!owner || !repo) {
      console.error('Owner or repo is not provided:', { owner, repo });
      return { status: 'unknown', url: '', message: 'Unable to determine owner and repo.' };
    }

    if (!ciType) {
      console.log('CI type not provided, build status check disabled');
      return { status: 'unknown', url: '', message: 'CI type not detected, build status check disabled' };
    }

    try {
      if (ciType === 'github') {
        return await this.getGitHubBuildStatus(tag, owner, repo);
      } else if (ciType === 'gitlab') {
        return await this.getGitLabBuildStatus(tag, owner, repo);
      } else {
        throw new Error('Unsupported CI type');
      }
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
          : `${this.apiUrl}/${owner}/${repo}/-/pipelines`,
        message
      };
    }
  }

  private async getGitHubBuildStatus(tag: string, owner: string, repo: string): Promise<{ status: string, url: string, message?: string }> {
    const workflowsUrl = `${this.apiUrl}/repos/${owner}/${repo}/actions/workflows`;
    console.log('Fetching workflows from:', workflowsUrl);

    const workflowsResponse = await axios.get(workflowsUrl, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    console.log('Workflows response:', workflowsResponse.data);

    if (workflowsResponse.data.total_count === 0) {
      console.log('No workflows found in the repository.');
      return { status: 'unknown', url: `https://github.com/${owner}/${repo}/actions` };
    }

    const workflowId = workflowsResponse.data.workflows[0].id;
    const runsUrl = `${this.apiUrl}/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs`;
    console.log('Fetching runs from:', runsUrl);

    const runsResponse = await axios.get(runsUrl, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      params: {
        branch: tag,
        per_page: 1
      }
    });

    console.log('Runs response:', runsResponse.data);

    if (runsResponse.data.total_count === 0) {
      console.log(`No runs found for tag: ${tag}`);
      return { 
        status: 'pending', 
        url: `https://github.com/${owner}/${repo}/actions`,
        message: `No runs found for tag: ${tag}`
      };
    }

    const latestRun = runsResponse.data.workflow_runs[0];
    const status = latestRun.status === 'completed' ? latestRun.conclusion : latestRun.status;
    console.log(`GitHub CI returning status: ${status} for tag: ${tag}`);
    return { 
      status: status,
      url: latestRun.html_url,
      message: `GitHub CI returning status: ${status} for tag: ${tag}`
    };
  }

  private async getGitLabBuildStatus(tag: string, owner: string, repo: string): Promise<{ status: string, url: string, message?: string }> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const pipelinesUrl = `${this.apiUrl}/api/v4/projects/${projectId}/pipelines`;
    console.log('Fetching pipelines from:', pipelinesUrl);

    const pipelinesResponse = await axios.get(pipelinesUrl, {
      headers: {
        'PRIVATE-TOKEN': this.token
      },
      params: {
        ref: tag,
        order_by: 'id',
        sort: 'desc',
        per_page: 1
      }
    });

    console.log('Pipelines response:', pipelinesResponse.data);

    if (pipelinesResponse.data.length === 0) {
      console.log(`No pipelines found for tag: ${tag}`);
      return { 
        status: 'pending', 
        url: `${this.apiUrl}/${owner}/${repo}/-/pipelines`,
        message: `No pipelines found for tag: ${tag}`
      };
    }

    const latestPipeline = pipelinesResponse.data[0];
    const status = this.mapGitLabStatus(latestPipeline.status);
    console.log(`GitLab CI returning status: ${status} for tag: ${tag}`);
    return { 
      status: status,
      url: `${this.apiUrl}/${owner}/${repo}/-/pipelines/${latestPipeline.id}`,
      message: `GitLab CI returning status: ${status} for tag: ${tag}`
    };
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
}