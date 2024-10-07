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

  suite('getOwnerAndRepo', () => {
    const testCases = [
      {
        name: 'GitHub HTTPS URL',
        url: 'https://github.com/owner/repo.git',
        expected: { owner: 'owner', repo: 'repo' }
      },
      {
        name: 'GitHub SSH URL',
        url: 'git@github.com:owner/repo.git',
        expected: { owner: 'owner', repo: 'repo' }
      },
      {
        name: 'GitHub HTTPS URL with credentials',
        url: 'https://username:token@github.com/owner/repo.git',
        expected: { owner: 'owner', repo: 'repo' }
      },
      {
        name: 'GitLab HTTPS URL',
        url: 'https://gitlab.com/owner/repo.git',
        expected: { owner: 'owner', repo: 'repo' }
      },
      {
        name: 'GitLab SSH URL',
        url: 'git@gitlab.com:owner/repo.git',
        expected: { owner: 'owner', repo: 'repo' }
      },
      {
        name: 'GitLab HTTPS URL with credentials',
        url: 'https://username:token@gitlab.com/owner/repo.git',
        expected: { owner: 'owner', repo: 'repo' }
      },
      {
        name: 'GitLab HTTPS URL with subgroup',
        url: 'https://gitlab.com/group/subgroup/repo.git',
        expected: { owner: 'group/subgroup', repo: 'repo' }
      },
      {
        name: 'GitLab SSH URL with subgroup',
        url: 'git@gitlab.com:group/subgroup/repo.git',
        expected: { owner: 'group/subgroup', repo: 'repo' }
      },
      {
        name: 'GitLab HTTPS URL with multiple subgroups',
        url: 'https://gitlab.com/group/subgroup1/subgroup2/repo.git',
        expected: { owner: 'group/subgroup1/subgroup2', repo: 'repo' }
      },
      {
        name: 'GitLab SSH URL with multiple subgroups',
        url: 'git@gitlab.com:group/subgroup1/subgroup2/repo.git',
        expected: { owner: 'group/subgroup1/subgroup2', repo: 'repo' }
      }
    ];

    testCases.forEach(({ name, url, expected }) => {
      test(`getOwnerAndRepo should extract owner and repo from ${name}`, async () => {
        sandbox.stub(gitService, 'getRemoteUrl').resolves(url);
        
        const result = await gitService.getOwnerAndRepo();
        assert.deepStrictEqual(result, expected);
      });
    });
  });
});