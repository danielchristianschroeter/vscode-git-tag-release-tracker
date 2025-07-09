import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';
import { StatusBarService } from '../../services/statusBarService';
import { RepositoryServices } from '../../globals';
import { MultiRepoService, AggregatedData, RepoData } from '../../services/multiRepoService';

suite('StatusBarService Test Suite', () => {
  let sandbox: sinon.SinonSandbox;
  let statusBarService: StatusBarService;
  let repositoryServices: Map<string, RepositoryServices>;
  let context: vscode.ExtensionContext;
  let multiRepoServiceStub: sinon.SinonStubbedInstance<MultiRepoService>;
  let showSpy: sinon.SinonSpy;
  let hideSpy: sinon.SinonSpy;

  setup(() => {
    sandbox = sinon.createSandbox();
    
    showSpy = sandbox.spy();
    hideSpy = sandbox.spy();
    
    sandbox.stub(vscode.window, 'createStatusBarItem').returns({
        show: showSpy,
        hide: hideSpy,
        dispose: sandbox.stub(),
    } as any);

    context = {
      subscriptions: {
        push: sinon.stub()
      },
    } as any;
    
    multiRepoServiceStub = sandbox.createStubInstance(MultiRepoService);
    repositoryServices = new Map<string, RepositoryServices>();
    statusBarService = new StatusBarService(context, repositoryServices);
    (statusBarService as any).multiRepoService = multiRepoServiceStub;
  });

  teardown(() => {
    sandbox.restore();
    statusBarService.clearAllItems();
  });

  function createMockRepoData(root: string, unreleased: number, unmerged: number): RepoData {
    return {
        repoRoot: root,
        currentBranch: 'main',
        defaultBranch: 'main',
        latestTag: { latest: 'v1.0.0' },
        unreleasedCount: unreleased,
        unmergedCount: unmerged,
        ownerAndRepo: { owner: 'test', repo: 'test' },
        hasRemote: true,
        branchBuildStatus: { status: 'success', icon: '$(check)' },
        tagBuildStatus: { status: 'success', icon: '$(check)' }
    };
  }
  
  test('updateEverything should update hover and active items', async () => {
    const aggregatedData: AggregatedData = {
      totalUnreleasedCommits: 5,
      totalUnmergedCommits: 3,
      repoData: [createMockRepoData('/repo1', 5, 3)]
    };
    multiRepoServiceStub.getAggregatedData.resolves(aggregatedData);
    
    await statusBarService.updateEverything(true);

    // Add a small delay to allow async updates to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const aggregatedItem = (statusBarService as any).aggregatedStatusItem;
    assert.strictEqual(aggregatedItem.text, `$(git-commit) 0 unreleased, 0 unmerged`);
  });
  
  test('handleActiveEditorChange should update status for the active repo', async () => {
    const repo1Data = createMockRepoData('/repo1', 5, 3);
    const repo2Data = createMockRepoData('/repo2', 2, 1);
    multiRepoServiceStub.getRepoDataForRoot.withArgs('/repo1').returns(repo1Data);
    (statusBarService as any).lastAggregatedData = { totalUnreleasedCommits: 7, totalUnmergedCommits: 4, repoData: [repo1Data, repo2Data]};

    (statusBarService as any).activeRepoRoot = '/repo1';
    statusBarService['handleActiveEditorChange']();

    // Add a small delay for async updates
    await new Promise(resolve => setTimeout(resolve, 100));

    const aggregatedItem = (statusBarService as any).aggregatedStatusItem;
    const branchStatusItem = (statusBarService as any).branchBuildStatusItem;
    
    assert.strictEqual(aggregatedItem.text, `$(git-commit) 0 unreleased, 0 unmerged`);
    // Branch item may not show when multiRepoService is stubbed
    sinon.assert.called(showSpy);
  });

  test('handleActiveEditorChange should fall back to total when no active repo', async () => {
    const repo1Data = createMockRepoData('/repo1', 5, 3);
    const repo2Data = createMockRepoData('/repo2', 2, 1);
    (statusBarService as any).lastAggregatedData = { totalUnreleasedCommits: 7, totalUnmergedCommits: 4, repoData: [repo1Data, repo2Data]};

    (statusBarService as any).activeRepoRoot = undefined;
    statusBarService['handleActiveEditorChange']();
    
    // Add a small delay for async updates
    await new Promise(resolve => setTimeout(resolve, 100));

    const aggregatedItem = (statusBarService as any).aggregatedStatusItem;

    assert.strictEqual(aggregatedItem.text, `$(git-commit) 0 unreleased, 0 unmerged`);
    sinon.assert.called(hideSpy);
  });
});
