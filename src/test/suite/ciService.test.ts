import assert from 'assert';
import * as sinon from 'sinon';
import axios from 'axios';
import { CIService } from '../../services/ciService';
import * as vscode from 'vscode';

suite('CIService Test Suite', () => {
  let ciService: CIService;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string) => {
        if (key === 'ciProviders') {
          return {
            github: { token: 'fake-github-token', apiUrl: 'https://api.github.com' },
            gitlab: { token: 'fake-gitlab-token', apiUrl: 'https://gitlab.com' }
          };
        }
        return undefined;
      }
    } as any);
    ciService = new CIService();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('getBuildStatus should return correct status for GitHub tag', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.resolves({
      data: {
        total_count: 1,
        workflow_runs: [{
          id: 123,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/owner/repo/actions/runs/123',
          head_commit: {
            id: '1234567890abcdef'
          },
          head_branch: '1.0.0'
        }],
      },
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '1609459200',
      },
    });
    
    const result = await ciService.getBuildStatus('1.0.0', 'owner', 'repo', 'github', true);
    assert.deepStrictEqual(result, { 
      status: 'success', 
      url: 'https://github.com/owner/repo/actions/runs/123',
      message: 'GitHub CI returning status: success for tag 1.0.0',
      response: {
        data: {
          total_count: 1,
          workflow_runs: [{
            id: 123,
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/owner/repo/actions/runs/123',
            head_commit: {
              id: '1234567890abcdef'
            },
            head_branch: '1.0.0'
          }],
        },
        headers: {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': '1609459200',
        },
      }
    });
  });

  test('getBuildStatus should return correct status for GitHub branch', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.resolves({
      data: {
        total_count: 1,
        workflow_runs: [{
          id: 123,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/owner/repo/actions/runs/123',
          head_commit: {
            id: '1234567890abcdef'
          },
          head_branch: 'main'
        }],
      },
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '1609459200',
      },
    });
    
    const result = await ciService.getBuildStatus('main', 'owner', 'repo', 'github', false);
    assert.deepStrictEqual(result, { 
      status: 'success', 
      url: 'https://github.com/owner/repo/actions/runs/123',
      message: 'GitHub CI returning status: success for branch main',
      response: {
        data: {
          total_count: 1,
          workflow_runs: [{
            id: 123,
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/owner/repo/actions/runs/123',
            head_commit: {
              id: '1234567890abcdef'
            },
            head_branch: 'main'
          }],
        },
        headers: {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': '1609459200',
        },
      }
    });
  });

  test('getBuildStatus should return correct status for GitLab tag', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.resolves({
      data: [{
        id: 123,
        status: 'success',
        web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
        ref: '1.0.0'
      }],
      headers: {
        'ratelimit-limit': '5000',
        'ratelimit-remaining': '4999',
        'ratelimit-reset': '1609459200',
      },
    });
    
    const result = await ciService.getBuildStatus('1.0.0', 'owner', 'repo', 'gitlab', true);
    assert.deepStrictEqual(result, { 
      status: 'success', 
      url: 'https://gitlab.com/owner/repo/-/pipelines/123',
      message: 'GitLab CI returning status: success for tag 1.0.0',
      response: {
        data: [{
          id: 123,
          status: 'success',
          web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
          ref: '1.0.0'
        }],
        headers: {
          'ratelimit-limit': '5000',
          'ratelimit-remaining': '4999',
          'ratelimit-reset': '1609459200',
        },
      }
    });
  });

  test('getBuildStatus should return correct status for GitLab branch', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.resolves({
      data: [{
        id: 123,
        status: 'success',
        web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
        ref: 'main'
      }],
      headers: {
        'ratelimit-limit': '5000',
        'ratelimit-remaining': '4999',
        'ratelimit-reset': '1609459200',
      },
    });
    
    const result = await ciService.getBuildStatus('main', 'owner', 'repo', 'gitlab', false);
    assert.deepStrictEqual(result, { 
      status: 'success', 
      url: 'https://gitlab.com/owner/repo/-/pipelines/123',
      message: 'GitLab CI returning status: success for branch main',
      response: {
        data: [{
          id: 123,
          status: 'success',
          web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
          ref: 'main'
        }],
        headers: {
          'ratelimit-limit': '5000',
          'ratelimit-remaining': '4999',
          'ratelimit-reset': '1609459200',
        },
      }
    });
  });

  test('getBuildStatus should return no_runs for GitLab when no matching pipeline is found', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.resolves({
      data: [{
        id: 123,
        status: 'success',
        web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
        ref: 'main'
      }],
      headers: {
        'ratelimit-limit': '5000',
        'ratelimit-remaining': '4999',
        'ratelimit-reset': '1609459200',
      },
    });
    
    const result = await ciService.getBuildStatus('1.0.0', 'owner', 'repo', 'gitlab', true);
    assert.deepStrictEqual(result, { 
      status: 'no_runs', 
      url: 'https://gitlab.com/owner/repo/-/pipelines',
      message: 'No matching pipeline found for tag 1.0.0',
      response: {
        data: [{
          id: 123,
          status: 'success',
          web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
          ref: 'main'
        }],
        headers: {
          'ratelimit-limit': '5000',
          'ratelimit-remaining': '4999',
          'ratelimit-reset': '1609459200',
        },
      }
    });
  });

  test('getImmediateBuildStatus should return fresh status', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.resolves({
      data: {
        total_count: 1,
        workflow_runs: [{
          id: 123,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/owner/repo/actions/runs/123',
          head_commit: {
            id: '1234567890abcdef'
          },
          head_branch: 'main'
        }],
      },
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '1609459200',
      },
    });
  
    const result = await ciService.getImmediateBuildStatus('main', 'owner', 'repo', 'github', false);
    assert.deepStrictEqual(result, { 
      status: 'success', 
      url: 'https://github.com/owner/repo/actions/runs/123',
      message: 'GitHub CI returning status: success for branch main',
      response: {
        data: {
          total_count: 1,
          workflow_runs: [{
            id: 123,
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/owner/repo/actions/runs/123',
            head_commit: {
              id: '1234567890abcdef'
            },
            head_branch: 'main'
          }],
        },
        headers: {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': '1609459200',
        },
      }
    });
  });
});