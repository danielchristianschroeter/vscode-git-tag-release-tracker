import assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../../services/gitService';
import * as vscode from 'vscode';
import mock from 'mock-fs';

suite('GitService Test Suite', () => {
  let gitService: GitService;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    gitService = new GitService();
    sandbox = sinon.createSandbox();
    
    // Mock the file system
    mock({
      '/mock/repo': {
        '.git': {},  // Simulate a git repository
      },
    });

    // Mock vscode.workspace.workspaceFolders
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: { fsPath: '/mock/repo' } }
    ] as any);

    // Initialize Git
    gitService.initializeGit();
    
    // Mock fs module
    mock({
      '/mock/repo': {
        '.git': {},  // Simulate a git repository
      },
    });
  });

  teardown(() => {
    sandbox.restore();
    mock.restore();
  });

  test('detectCIType should return github for GitHub Actions', () => {
    mock({
      '/mock/repo': {
        '.git': {},
        '.github': {
          'workflows': {
            'main.yml': 'content',
          },
        },
      },
    });
    
    // Force re-initialization of Git
    gitService['currentRepoPath'] = '/mock/repo';
    gitService.initializeGit();
    
    const result = gitService.detectCIType();
    assert.strictEqual(result, 'github');
  });

  test('detectCIType should return gitlab for GitLab CI', () => {
    mock({
      '/mock/repo': {
        '.git': {},
        '.gitlab-ci.yml': 'content',
      },
    });
    
    // Force re-initialization of Git
    gitService['currentRepoPath'] = '/mock/repo';
    gitService.initializeGit();
    
    const result = gitService.detectCIType();
    assert.strictEqual(result, 'gitlab');
  });

  test('detectCIType should return null when no CI configuration is found', () => {
    mock({
      '/mock/repo': {
        '.git': {},
      },
    });
    
    const result = gitService.detectCIType();
    assert.strictEqual(result, null);
  });

  test('getOwnerAndRepo should extract owner and repo from GitHub URL', async () => {
    sandbox.stub(gitService, 'getRemoteUrl').resolves('https://github.com/owner/repo.git');
    
    const result = await gitService.getOwnerAndRepo();
    assert.deepStrictEqual(result, { owner: 'owner', repo: 'repo' });
  });
});