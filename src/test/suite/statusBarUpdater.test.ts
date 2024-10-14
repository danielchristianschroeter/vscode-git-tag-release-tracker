import assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GitService } from '../../services/gitService';
import { StatusBarService } from '../../services/statusBarService';
import { CIService } from '../../services/ciService';
import { updateStatusBar, createStatusBarUpdater } from '../../utils/statusBarUpdater';
import { setupTestEnvironment, teardownTestEnvironment } from './testSetup';
import { Logger } from '../../utils/logger';

suite('StatusBarUpdater Test Suite', () => {
  let sandbox: sinon.SinonSandbox;
  let testEnv: ReturnType<typeof setupTestEnvironment>;
  let gitService: sinon.SinonStubbedInstance<GitService>;
  let statusBarService: sinon.SinonStubbedInstance<StatusBarService>;
  let ciService: sinon.SinonStubbedInstance<CIService>;

  setup(() => {
    testEnv = setupTestEnvironment();
    sandbox = testEnv.sandbox;
    
    gitService = sandbox.createStubInstance(GitService);
    statusBarService = sandbox.createStubInstance(StatusBarService);
    ciService = sandbox.createStubInstance(CIService);

    // Stub Logger to prevent actual logging during tests
    sandbox.stub(Logger, 'log');
  });

  teardown(() => {
    teardownTestEnvironment(sandbox);
  });

  test('updateStatusBar should update status bar and CI status for both tag and branch', async () => {
    // Set up the stubs
    gitService.isInitialized.returns(true);
    gitService.getCurrentRepo.resolves('testrepo');
    gitService.getCurrentBranch.resolves('main');
    gitService.fetchAndTags.resolves({ latest: '1.0.0', all: ['1.0.0'] });
    gitService.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });
    gitService.detectCIType.returns('github');

    // Call the function
    await updateStatusBar(gitService, statusBarService);

    // Assertions
    sinon.assert.calledOnce(gitService.isInitialized);
    sinon.assert.calledOnce(gitService.getCurrentRepo);
    sinon.assert.calledOnce(gitService.getCurrentBranch);
    sinon.assert.calledOnce(gitService.getOwnerAndRepo);
    sinon.assert.calledOnce(gitService.detectCIType);
    sinon.assert.calledOnce(statusBarService.updateEverything);
  });

  test('updateStatusBar should not update when GitService is not initialized', async () => {
    gitService.isInitialized.returns(false);
    gitService.initialize.resolves(false);

    await updateStatusBar(gitService, statusBarService);

    sinon.assert.calledOnce(gitService.isInitialized);
    sinon.assert.calledOnce(gitService.initialize);
    sinon.assert.notCalled(statusBarService.updateEverything);
  });

  test('updateStatusBar should not update when no Git repository is detected', async () => {
    gitService.isInitialized.returns(true);
    gitService.getCurrentRepo.resolves(null);

    await updateStatusBar(gitService, statusBarService);

    sinon.assert.calledOnce(gitService.isInitialized);
    sinon.assert.calledOnce(gitService.getCurrentRepo);
    sinon.assert.notCalled(statusBarService.updateEverything);
  });

  test('createStatusBarUpdater should return an object with updateNow and debouncedUpdate functions', () => {
    const updater = createStatusBarUpdater(gitService, statusBarService);

    assert.strictEqual(typeof updater.updateNow, 'function');
    assert.strictEqual(typeof updater.debouncedUpdate, 'function');
  });

  test('createStatusBarUpdater.updateNow should call updateStatusBar', async () => {
    const updater = createStatusBarUpdater(gitService, statusBarService);
    gitService.isInitialized.returns(true);
    gitService.getCurrentRepo.resolves('testrepo');
    gitService.getCurrentBranch.resolves('main');
    gitService.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });
    gitService.detectCIType.returns('github');

    await updater.updateNow();

    sinon.assert.calledOnce(statusBarService.updateEverything);
  });
});
