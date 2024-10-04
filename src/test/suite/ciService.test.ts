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

  test('getBuildStatus should return correct status for GitHub', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.onFirstCall().resolves({
      data: {
        total_count: 1,
        workflows: [{ id: 123 }],
      },
    });
    axiosStub.onSecondCall().resolves({
      data: {
        total_count: 1,
        workflow_runs: [{
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/owner/repo/actions/runs/123',
        }],
      },
    });
    
    const result = await ciService.getBuildStatus('1.0.0', 'owner', 'repo', 'github');
    assert.deepStrictEqual(result, { 
      status: 'success', 
      url: 'https://github.com/owner/repo/actions/runs/123',
      message: 'GitHub CI returning status: success for tag: 1.0.0'
    });
  });

  test('getBuildStatus should return correct status for GitLab', async () => {
    const axiosStub = sandbox.stub(axios, 'get');
    axiosStub.resolves({
      data: [{
        id: 123,
        status: 'success',
        web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
      }],
    });
    
    const result = await ciService.getBuildStatus('1.0.0', 'owner', 'repo', 'gitlab');
    assert.deepStrictEqual(result, { 
      status: 'success', 
      url: 'https://gitlab.com/owner/repo/-/pipelines/123',
      message: 'GitLab CI returning status: success for tag: 1.0.0'
    });
  });
});