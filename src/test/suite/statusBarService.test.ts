import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { StatusBarService } from '../../services/statusBarService';
import { GitService } from '../../services/gitService';
import { CIService } from '../../services/ciService';
import { setupTestEnvironment, teardownTestEnvironment } from './testSetup';
import { Logger } from '../../utils/logger';

suite('StatusBarService Test Suite', () => {
  let sandbox: sinon.SinonSandbox;
  let testEnv: ReturnType<typeof setupTestEnvironment>;
  let statusBarService: StatusBarService;
  let gitServiceStub: sinon.SinonStubbedInstance<GitService>;
  let ciServiceStub: sinon.SinonStubbedInstance<CIService>;
  let contextStub: sinon.SinonStubbedInstance<vscode.ExtensionContext>;
  let loggerSpy: sinon.SinonSpy;

  setup(() => {
    testEnv = setupTestEnvironment();
    sandbox = testEnv.sandbox;
    
    // Create event emitters
    const repoChangedEmitter = new vscode.EventEmitter<{ oldRepo: string | null, newRepo: string, oldBranch: string | null, newBranch: string | null }>();
    const branchChangedEmitter = new vscode.EventEmitter<{ oldBranch: string | null, newBranch: string | null }>();
    const gitPushEmitter = new vscode.EventEmitter<void>();

    // Create the GitService stub
    gitServiceStub = sandbox.createStubInstance(GitService);
    
    // Override the read-only properties with the event emitters
    Object.defineProperties(gitServiceStub, {
      onRepoChanged: {
        get: () => repoChangedEmitter.event
      },
      onBranchChanged: {
        get: () => branchChangedEmitter.event
      },
      onGitPush: {
        get: () => gitPushEmitter.event
      }
    });

    ciServiceStub = sandbox.createStubInstance(CIService);
    contextStub = {
      subscriptions: [],
    } as unknown as sinon.SinonStubbedInstance<vscode.ExtensionContext>;

    // Mock vscode.window.createStatusBarItem
    sandbox.stub(vscode.window, 'createStatusBarItem').returns({
      hide: sandbox.stub(),
      show: sandbox.stub(),
      dispose: sandbox.stub(),
    } as unknown as vscode.StatusBarItem);

    statusBarService = new StatusBarService(
      ['command1', 'command2'],
      contextStub,
      gitServiceStub,
      ciServiceStub
    );

    // Create a spy on Logger.log
    loggerSpy = sandbox.spy(Logger, 'log');
  });

  teardown(() => {
    teardownTestEnvironment(sandbox);
  });

  test('updateCommitCountButton should show correct count for default branch', async () => {
    gitServiceStub.getCurrentBranch.resolves('main');
    gitServiceStub.getDefaultBranch.resolves('main');
    gitServiceStub.fetchAndTags.resolves({ latest: 'v1.0.0', all: ['v1.0.0'] });
    gitServiceStub.getCommitCounts.resolves(5);
    gitServiceStub.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });

    // Mock the buttons array
    (statusBarService as any).buttons = Array(5).fill({}).map(() => ({
      text: '',
      tooltip: '',
      command: '',
      show: sinon.stub(),
      hide: sinon.stub()
    }));

    await (statusBarService as any).updateCommitCountButton();

    const buttons = (statusBarService as any).buttons;
    assert.strictEqual(buttons[4].text, '5 unreleased commits');
    assert.strictEqual(buttons[4].tooltip, '5 unreleased commits in testowner/testrepo/main since tag v1.0.0\nClick to open compare view for unreleased commits');
  });

  test('updateCommitCountButton should show correct count for feature branch', async () => {
    gitServiceStub.getCurrentBranch.resolves('feature/new-feature');
    gitServiceStub.getDefaultBranch.resolves('main');
    gitServiceStub.getCommitCounts.resolves(3);
    gitServiceStub.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });

    // Mock the buttons array
    (statusBarService as any).buttons = Array(5).fill({}).map(() => ({
      text: '',
      tooltip: '',
      command: '',
      show: sinon.stub(),
      hide: sinon.stub()
    }));

    await (statusBarService as any).updateCommitCountButton();

    const buttons = (statusBarService as any).buttons;
    assert.strictEqual(buttons[4].text, '3 unmerged commits');
    assert.strictEqual(buttons[4].tooltip, '3 unmerged commits in testowner/testrepo/feature/new-feature compared to main\nClick to open compare view');
  });

  test('updateCIStatus should update tag build status correctly for GitHub', async () => {
    const mockStatusBarItem = {
      text: '',
      tooltip: '',
      command: '',
      show: sinon.stub(),
      hide: sinon.stub()
    };
    (statusBarService as any).tagBuildStatusItem = mockStatusBarItem;

    gitServiceStub.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });
    const githubUrl = 'https://github.com/testowner/testrepo/actions/runs/123';

    await statusBarService.updateCIStatus('success', 'v1.0.0', githubUrl, true);

    assert.ok(mockStatusBarItem.text.includes('success'), `Expected text to include 'success', but got: ${mockStatusBarItem.text}`);
    assert.ok(mockStatusBarItem.tooltip.includes('Click to open tag build status'));
    assert.strictEqual((statusBarService as any).tagBuildStatusUrl, githubUrl, 'Tag build status URL should be set correctly');
  });

  test('updateCIStatus should update branch build status correctly for GitLab', async () => {
    const mockStatusBarItem = {
      text: '',
      tooltip: '',
      command: '',
      show: sinon.stub(),
      hide: sinon.stub()
    };
    (statusBarService as any).branchBuildStatusItem = mockStatusBarItem;

    gitServiceStub.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });
    const gitlabUrl = 'https://gitlab.com/testowner/testrepo/-/pipelines/456';

    await statusBarService.updateCIStatus('in_progress', 'main', gitlabUrl, false);

    assert.ok(mockStatusBarItem.text.includes('in_progress'), `Expected text to include 'in_progress', but got: ${mockStatusBarItem.text}`);
    assert.ok(mockStatusBarItem.tooltip.includes('Click to open branch build status'));
    assert.strictEqual((statusBarService as any).branchBuildStatusUrl, gitlabUrl, 'Branch build status URL should be set correctly');
  });

  test('updateEverything should update all status bar items', async () => {
    gitServiceStub.isInitialized.returns(true);
    gitServiceStub.getCurrentRepo.resolves('testowner/testrepo');
    gitServiceStub.getCurrentBranch.resolves('main');
    gitServiceStub.getDefaultBranch.resolves('main');
    gitServiceStub.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });
    gitServiceStub.detectCIType.returns('github');
    gitServiceStub.fetchAndTags.resolves({ latest: 'v1.0.0', all: ['v1.0.0'] });
    gitServiceStub.getCommitCounts.resolves(5);

    const githubUrl = 'https://github.com/testowner/testrepo/actions/runs/123';
    ciServiceStub.getBuildStatus.resolves({ 
      status: 'success', 
      url: githubUrl, 
      message: 'Build successful' 
    });

    // Mock the buttons array
    const mockButtons = Array(5).fill({}).map(() => ({
      text: '',
      tooltip: '',
      command: '',
      show: sinon.stub(),
      hide: sinon.stub()
    }));
    (statusBarService as any).buttons = mockButtons;

    // Spy on the updateVersionButtons and updateCommitCountButton methods
    const updateVersionButtonsSpy = sandbox.spy(statusBarService as any, 'updateVersionButtons');
    const updateCommitCountButtonSpy = sandbox.spy(statusBarService as any, 'updateCommitCountButton');

    // Reset the isUpdating flag
    (statusBarService as any).isUpdating = false;

    try {
      await statusBarService.updateEverything(true);
    } catch (error) {
      console.error('Error in updateEverything:', error);
    }

    // Wait for any asynchronous operations to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Print all logged messages
    // console.log('Logged messages:');
    // loggerSpy.getCalls().forEach((call, index) => {
    //   console.log(`Log ${index + 1}:`, call.args[0], call.args[1]);
    // });

    // Check if the methods were called
    assert.ok(updateVersionButtonsSpy.called, 'updateVersionButtons should be called');
    assert.ok(updateCommitCountButtonSpy.called, 'updateCommitCountButton should be called');

    // Verify that updateCommitCountButton was called
    const commitCountButton = mockButtons[4];

    assert.ok(commitCountButton.text.includes('5'), `Commit count button should include the number 5. Actual text: "${commitCountButton.text}"`);
    assert.ok(commitCountButton.text.toLowerCase().includes('unreleased'), `Commit count button should mention unreleased commits. Actual text: "${commitCountButton.text}"`);
    assert.ok(commitCountButton.tooltip.includes('5 unreleased commits in testowner/testrepo/main since tag v1.0.0'), `Commit count button should have correct tooltip. Actual tooltip: "${commitCountButton.tooltip}"`);
    assert.ok(commitCountButton.show.called, 'Commit count button should be shown');

    // Verify that updateCIStatus was called for the branch
    assert.strictEqual((statusBarService as any).branchBuildStatusUrl, githubUrl, 'Branch build status URL should be set correctly');

    // Verify that updateVersionButtons was called
    const majorButton = mockButtons[0];
    const minorButton = mockButtons[1];
    const patchButton = mockButtons[2];

    assert.ok(majorButton.text.includes('2.0.0'), 'Major version button should be visible');
    assert.ok(minorButton.text.includes('1.1.0'), 'Minor version button should be visible');
    assert.ok(patchButton.text.includes('1.0.1'), 'Patch version button should be visible');

    assert.ok(majorButton.show.called, 'Major version button should be shown');
    assert.ok(minorButton.show.called, 'Minor version button should be shown');
    assert.ok(patchButton.show.called, 'Patch version button should be shown');
  });
});
