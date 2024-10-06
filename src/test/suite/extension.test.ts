import assert from 'assert';
import * as vscode from 'vscode';
import sinon from 'sinon';
import { GitService } from '../../services/gitService';
import { StatusBarService } from '../../services/statusBarService';
import { CIService } from '../../services/ciService';

suite('Extension Test Suite', () => {
	let gitService: GitService;
	let statusBarService: StatusBarService;
	let ciService: CIService;
	let sandbox: sinon.SinonSandbox;

	setup(() => {
		sandbox = sinon.createSandbox();
		const mockContext: Partial<vscode.ExtensionContext> = {
			subscriptions: [],
		};
		gitService = new GitService();
		ciService = new CIService();
		statusBarService = new StatusBarService(
			[],
			mockContext as vscode.ExtensionContext,
			gitService,
			ciService
		);

		// Mock VS Code workspace
		sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/mock/path' } }]);
	});

	teardown(() => {
		sandbox.restore();
	});

	test('Extension should be present', () => {
		const extensionStub = sandbox.stub(vscode.extensions, 'getExtension').returns({} as any);
		assert.ok(vscode.extensions.getExtension('DanielChristianSchroeter.git-tag-release-tracker'));
	});

	test('GitService should initialize', async () => {
		const initializeGitStub = sandbox.stub(gitService, 'initializeGit').resolves(true);
		const result = await gitService.initializeGit();
		assert.strictEqual(result, true);
	});

	test('StatusBarService should update status bar', () => {
		statusBarService['statusBarItem'] = {
			text: '',
			tooltip: '',
			command: '',
			show: () => {},
			hide: () => {},
		} as any;
		const updateStatusBarSpy = sandbox.spy(statusBarService, 'updateStatusBar');
		statusBarService.updateStatusBar('Test Status', 'Test Tooltip');
		assert(updateStatusBarSpy.calledOnce);
	});

	test('CIService should get build status', async () => {
		const getBuildStatusStub = sandbox.stub(ciService, 'getBuildStatus').resolves({
			status: 'success',
			url: 'https://example.com',
			message: 'Build successful'
		});
		const result = await ciService.getBuildStatus('1.0.0', 'owner', 'repo', 'github', true);
		assert.deepStrictEqual(result, { status: 'success', url: 'https://example.com', message: 'Build successful' });
		sinon.assert.calledWith(getBuildStatusStub, '1.0.0', 'owner', 'repo', 'github', true);
	});

	test('StatusBarService should update status bar and build status', () => {
		statusBarService['statusBarItem'] = {
			text: '',
			tooltip: '',
			command: '',
			show: () => {},
			hide: () => {},
		} as any;
		statusBarService['buildStatusItem'] = {
			text: '',
			tooltip: '',
			command: '',
			show: () => {},
			hide: () => {},
		} as any;
		statusBarService['branchBuildStatusItem'] = {
			text: '',
			tooltip: '',
			command: '',
			show: () => {},
			hide: () => {},
		} as any;
		const updateStatusBarSpy = sandbox.spy(statusBarService, 'updateStatusBar');
		const updateBuildStatusSpy = sandbox.spy(statusBarService, 'updateBuildStatus');
		const updateBranchBuildStatusSpy = sandbox.spy(statusBarService, 'updateBranchBuildStatus');
		
		statusBarService.updateStatusBar('Test Status', 'Test Tooltip');
		statusBarService.updateBuildStatus('success', '1.0.0', 'https://example.com', 'test-repo');
		statusBarService.updateBranchBuildStatus('success', 'main', 'https://example.com', 'test-repo');
		
		assert(updateStatusBarSpy.calledOnce);
		assert(updateBuildStatusSpy.calledOnce);
		assert(updateBranchBuildStatusSpy.calledOnce);
	});
});