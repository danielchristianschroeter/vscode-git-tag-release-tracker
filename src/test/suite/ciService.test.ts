import * as assert from 'assert';
import * as sinon from 'sinon';
import { CIService } from '../../services/ciService';
import axios from 'axios';
import { setupTestEnvironment, teardownTestEnvironment } from './testSetup';
import * as vscode from 'vscode';
import { Logger } from '../../utils/logger';

suite('CIService Test Suite', () => {
	let sandbox: sinon.SinonSandbox;
	let testEnv: ReturnType<typeof setupTestEnvironment>;
	let ciService: CIService;

	setup(() => {
		testEnv = setupTestEnvironment();
		sandbox = testEnv.sandbox;
		ciService = new CIService();

		// Stub Logger to prevent actual logging during tests
		sandbox.stub(Logger, 'log');
	});

	teardown(() => {
		teardownTestEnvironment(sandbox);
	});

	test('getBuildStatus should return correct status for GitHub tag', async () => {
		const axiosStub = sandbox.stub(axios, 'get').resolves({
			data: {
				total_count: 1,
				workflow_runs: [{
					id: 123,
					status: 'completed',
					conclusion: 'success',
					html_url: 'https://github.com/owner/repo/actions/runs/123',
					head_commit: { id: '1234567890abcdef' },
					head_branch: '1.0.0'
				}],
			},
			headers: {
				'x-ratelimit-limit': '5000',
				'x-ratelimit-remaining': '4999',
				'x-ratelimit-reset': '1609459200'
			}
		});

		const result = await ciService.getBuildStatus('1.0.0', 'owner', 'repo', 'github', true);
		assert.strictEqual(result?.status, 'success');
		assert.strictEqual(result?.url, 'https://github.com/owner/repo/actions/runs/123');
	});

	test('getBuildStatus should return correct status for GitHub branch', async () => {
		const axiosStub = sandbox.stub(axios, 'get').resolves({
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
			message: 'GitHub CI returning status: success for branch main'
		});
	});

	test('getBuildStatus should return correct status for GitLab tag', async () => {
		const axiosStub = sandbox.stub(axios, 'get').resolves({
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
			url: 'https://gitlab.com/api/v4/owner/repo/-/pipelines/123',
			message: 'GitLab CI returning status: success for tag 1.0.0'
		});
	});

	test('getBuildStatus should return no_runs for GitLab when no matching pipeline is found', async () => {
		const axiosStub = sandbox.stub(axios, 'get').resolves({
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
			url: 'https://gitlab.com/api/v4/owner/repo/-/pipelines',
			message: 'No pipeline found for tag 1.0.0'
		});
	});

	test('getImmediateBuildStatus should return fresh status', async () => {
		sandbox.stub(axios, 'get').resolves({
			data: {
				total_count: 1,
				workflow_runs: [{
					id: 123,
					status: 'completed',
					conclusion: 'success',
					html_url: 'https://github.com/owner/repo/actions/runs/123',
					head_commit: { id: '1234567890abcdef' },
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
		assert.strictEqual(result.status, 'success');
	});

	test('Should handle errors gracefully when GitService fails', async () => {
		sandbox.stub(axios, 'get').rejects(new Error('Network error'));
		const result = await ciService.getBuildStatus('main', 'owner', 'repo', 'github', false);
		assert.strictEqual(result?.status, 'unknown');
		assert.strictEqual(result?.message, undefined);
		assert.strictEqual(result?.url, 'https://github.com/owner/repo/actions');
	});

	test('Should handle GitLab CI type correctly', async () => {
		sandbox.stub(axios, 'get').resolves({
			data: [{
				status: 'success',
				web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
				ref: 'main'
			}],
			headers: {}
		});
		const result = await ciService.getBuildStatus('main', 'owner', 'repo', 'gitlab', false);
		assert.strictEqual(result?.status, 'success');
	});

	test('Should handle no CI configuration', async () => {
		const result = await ciService.getBuildStatus('main', 'owner', 'repo', 'unknown' as any, false);
		assert.strictEqual(result?.status, 'unknown');
	});

	test('Should handle rate limiting', async () => {
		sandbox.stub(axios, 'get').resolves({
			data: { message: 'API rate limit exceeded' },
			headers: {
				'x-ratelimit-limit': '60',
				'x-ratelimit-remaining': '0',
				'x-ratelimit-reset': '1609459200'
			}
		});
		const result = await ciService.getBuildStatus('main', 'owner', 'repo', 'github', false);
		assert.strictEqual(result?.status, 'unknown');
		assert.strictEqual(result?.message, undefined);
		assert.strictEqual(result?.url, 'https://github.com/owner/repo/actions');
	});

	test('Should handle tag creation', async () => {
		sandbox.stub(axios, 'get').resolves({
			data: {
				total_count: 1,
				workflow_runs: [{
					id: 123,
					status: 'completed',
					conclusion: 'success',
					html_url: 'https://github.com/owner/repo/actions/runs/123',
					head_branch: 'v1.0.1',
					head_commit: {
						id: 'v1.0.1'
					}
				 }]
			},
			headers: {}
		});
		const result = await ciService.getBuildStatus('v1.0.1', 'owner', 'repo', 'github', true);
		assert.strictEqual(result?.status, 'success');
	});

	test('Should clear cache correctly', () => {
		ciService.clearCache();
		// @ts-ignore: Accessing private property for testing
		assert.deepStrictEqual(ciService.buildStatusCache, {});
	});

	test('Should clear cache for specific repo', () => {
		// @ts-ignore: Accessing private property for testing
		ciService.buildStatusCache = { 'owner/repo': { 'main/github': { status: 'success', url: 'test', timestamp: Date.now() } } };
		ciService.clearCacheForRepo('owner', 'repo');
		// @ts-ignore: Accessing private property for testing
		assert.deepStrictEqual(ciService.buildStatusCache, {});
	});

	test('Should clear cache for specific branch', () => {
		// @ts-ignore: Accessing private property for testing
		ciService.buildStatusCache = { 'owner/repo': { 'main/github': { status: 'success', url: 'test', timestamp: Date.now() } } };
		ciService.clearCacheForBranch('main', 'owner', 'repo', 'github');
		// @ts-ignore: Accessing private property for testing
		assert.deepStrictEqual(ciService.buildStatusCache, { 'owner/repo': {} });
	});

	test('Should correctly identify in-progress status', () => {
		assert.strictEqual(ciService.isInProgressStatus('pending'), true);
		assert.strictEqual(ciService.isInProgressStatus('in_progress'), true);
		assert.strictEqual(ciService.isInProgressStatus('success'), false);
	});
});
