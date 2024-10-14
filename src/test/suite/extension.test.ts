import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { GitService } from '../../services/gitService';
import { CIService } from '../../services/ciService';
import { StatusBarService } from '../../services/statusBarService';
import { setupTestEnvironment, teardownTestEnvironment } from './testSetup';
import { updateStatusBar } from '../../utils/statusBarUpdater';

suite('Extension Test Suite', () => {
	let sandbox: sinon.SinonSandbox;
	let testEnv: ReturnType<typeof setupTestEnvironment>;
	let gitService: sinon.SinonStubbedInstance<GitService>;
	let ciService: sinon.SinonStubbedInstance<CIService>;
	let statusBarService: sinon.SinonStubbedInstance<StatusBarService>;

	setup(() => {
		testEnv = setupTestEnvironment();
		sandbox = testEnv.sandbox;

		gitService = sandbox.createStubInstance(GitService);
		ciService = sandbox.createStubInstance(CIService);
		statusBarService = sandbox.createStubInstance(StatusBarService);

		// Setup default stub behaviors
		gitService.initialize.resolves(true);
		gitService.getCurrentRepo.resolves('test-repo');
		gitService.fetchAndTags.resolves({ latest: '1.0.0', all: ['1.0.0'] });
		gitService.getCurrentBranch.resolves('main');
		gitService.detectCIType.returns('github');
		gitService.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });

		ciService.getBuildStatus.resolves({ status: 'success', url: 'http://example.com' });
	});

	teardown(() => {
		teardownTestEnvironment(sandbox);
	});

	test('StatusBarService should update everything', async () => {
		await updateStatusBar(gitService, statusBarService);

		sinon.assert.calledOnce(statusBarService.updateEverything);
	});

	test('StatusBarService should update status bar and CI status', async () => {
		// Set up the stubs
		gitService.isInitialized.returns(true);
		gitService.getCurrentRepo.resolves('testrepo');
		gitService.getCurrentBranch.resolves('main');
		gitService.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });
		gitService.detectCIType.returns('github');
		gitService.fetchAndTags.resolves({ latest: '1.0.0', all: ['1.0.0'] });

		ciService.getBuildStatus.resolves({ status: 'success', url: 'http://example.com' });

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

	test('StatusBarService should update commit count button', async () => {
		// Set up the stubs
		gitService.isInitialized.returns(true);
		gitService.getCurrentRepo.resolves('testrepo');
		gitService.getCurrentBranch.resolves('main');
		gitService.getOwnerAndRepo.resolves({ owner: 'testowner', repo: 'testrepo' });
		gitService.detectCIType.returns('github');
		gitService.fetchAndTags.resolves({ latest: '1.0.0', all: ['1.0.0'] });

		// Call the function
		await updateStatusBar(gitService, statusBarService);

		// Assertions
		sinon.assert.calledOnce(statusBarService.updateEverything);
		
		// Verify that updateEverything is called with forceRefresh=false
		const updateEverythingCall = statusBarService.updateEverything.getCall(0);
		assert.strictEqual(updateEverythingCall.args[0], false, "updateEverything should be called with forceRefresh=false");
	});
});
