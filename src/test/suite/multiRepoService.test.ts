import * as sinon from 'sinon';
import * as assert from 'assert';
import { MultiRepoService, RepoData } from '../../services/multiRepoService';
import { GitService } from '../../services/gitService';
import { CIService } from '../../services/ciService';
import { RepositoryServices, globals } from '../../globals';

suite('MultiRepoService Test Suite', () => {
  let sandbox: sinon.SinonSandbox;
  let repositoryServices: Map<string, RepositoryServices>;
  let multiRepoService: MultiRepoService;

  setup(() => {
    sandbox = sinon.createSandbox();
    repositoryServices = new Map();
    globals.statusBarService = {
        triggerUpdate: sinon.stub()
    } as any;
  });

  teardown(() => {
    sandbox.restore();
    if (multiRepoService) {
        multiRepoService.stopPolling();
    }
  });

  function createMockServices(repoRoot: string): RepositoryServices {
    const gitService = sandbox.createStubInstance(GitService);
    const ciService = sandbox.createStubInstance(CIService);

    // Stub the constructor property to allow instanceof checks if needed
    Object.defineProperty(gitService, 'constructor', {
        value: GitService,
        writable: true,
    });
    Object.defineProperty(ciService, 'constructor', {
        value: CIService,
        writable: true,
    });
    
    // Stub methods with default return values
    gitService.getRepoRoot.returns(repoRoot);
    gitService.getCurrentBranch.resolves('main');
    gitService.getDefaultBranch.resolves('main');
    gitService.getOwnerAndRepo.resolves({ owner: 'test-owner', repo: 'test-repo' });
    gitService.getLatestTag.resolves({ latest: 'v1.0.0' });
    gitService.getCommitCounts.resolves(0);
    gitService.hasRemote.resolves(true);
    gitService.detectCIType.returns('github');
    ciService.getBuildStatus.resolves({ status: 'success' });
    ciService.isInProgressStatus.returns(false);


    return { gitService, ciService };
  }

  test('getAggregatedData should return aggregated data from multiple repositories', async () => {
    const services1 = createMockServices('/repo1');
    (services1.gitService.getCommitCounts as sinon.SinonStub).withArgs('v1.0.0', 'main', sinon.match.any).resolves(5); // 5 unreleased
    (services1.gitService.getCurrentBranch as sinon.SinonStub).resolves('feature/new-stuff');
    (services1.gitService.getCommitCounts as sinon.SinonStub).withArgs('main', 'feature/new-stuff', sinon.match.any).resolves(3); // 3 unmerged
    repositoryServices.set('/repo1', services1);

    const services2 = createMockServices('/repo2');
    (services2.gitService.getCommitCounts as sinon.SinonStub).withArgs('v1.0.0', 'main', sinon.match.any).resolves(2); // 2 unreleased
    repositoryServices.set('/repo2', services2);

    multiRepoService = new MultiRepoService(repositoryServices);
    const aggregatedData = await multiRepoService.getAggregatedData();

    assert.strictEqual(aggregatedData.totalUnreleasedCommits, 7, 'Should sum unreleased commits');
    assert.strictEqual(aggregatedData.totalUnmergedCommits, 3, 'Should sum unmerged commits');
    assert.strictEqual(aggregatedData.repoData.length, 2, 'Should have data for two repos');
    
    const repo1Data = aggregatedData.repoData.find(d => d.repoRoot === '/repo1');
    assert.strictEqual(repo1Data?.unreleasedCount, 5);
    assert.strictEqual(repo1Data?.unmergedCount, 3);

    const repo2Data = aggregatedData.repoData.find(d => d.repoRoot === '/repo2');
    assert.strictEqual(repo2Data?.unreleasedCount, 2);
    assert.strictEqual(repo2Data?.unmergedCount, 0);
  });

  test('invalidateCacheForRepo should set build statuses to loading', () => {
    multiRepoService = new MultiRepoService(repositoryServices);
    const repoData: RepoData = {
        repoRoot: '/repo1',
        currentBranch: 'main',
        defaultBranch: 'main',
        latestTag: null,
        unreleasedCount: 0,
        unmergedCount: 0,
        ownerAndRepo: null,
        hasRemote: true,
        branchBuildStatus: { status: 'success' },
        tagBuildStatus: { status: 'success' },
    };
    multiRepoService['cache'].set('/repo1', repoData);

    multiRepoService.invalidateCacheForRepo('/repo1');

    const loadingRepoData = multiRepoService.getRepoDataForRoot('/repo1');
    assert.strictEqual(loadingRepoData?.branchBuildStatus?.status, 'loading', 'Branch status should be loading');
    assert.strictEqual(loadingRepoData?.tagBuildStatus?.status, 'loading', 'Tag status should be loading');
    assert.ok((globals.statusBarService?.triggerUpdate as sinon.SinonStub).calledOnce, 'triggerUpdate should be called');
  });

  test('pollInProgressBuilds should refresh status for in-progress builds', async () => {
    const clock = sandbox.useFakeTimers();

    const services = createMockServices('/repo1');
    repositoryServices.set('/repo1', services);

    multiRepoService = new MultiRepoService(repositoryServices);
    
    // Setup initial state with an in-progress build
    const initialRepoData: RepoData = {
        repoRoot: '/repo1',
        currentBranch: 'main',
        defaultBranch: 'main',
        latestTag: { latest: 'v1.0.0' },
        unreleasedCount: 0,
        unmergedCount: 0,
        ownerAndRepo: { owner: 'test', repo: 'test' },
        hasRemote: true,
        branchBuildStatus: { status: 'in_progress' },
        tagBuildStatus: { status: 'success' },
        ciType: 'github'
    };
    multiRepoService['cache'].set('/repo1', initialRepoData);

    // Mock the services to reflect the polling logic
    (services.ciService.isInProgressStatus as sinon.SinonStub).withArgs('in_progress').returns(true);
    (services.ciService.isInProgressStatus as sinon.SinonStub).withArgs('success').returns(false);
    (services.ciService.getBuildStatus as sinon.SinonStub)
        .withArgs('main', 'github', false, true)
        .resolves({ status: 'success' }); // The new status after polling

    await multiRepoService['pollInProgressBuilds']();

    const updatedData = multiRepoService.getRepoDataForRoot('/repo1');
    assert.strictEqual(updatedData?.branchBuildStatus?.status, 'success', 'Branch build status should be updated to success');
    assert.ok((globals.statusBarService?.triggerUpdate as sinon.SinonStub).calledWith(false), 'UI should be triggered to update');

    await clock.tickAsync(5000);
  });

  test('clearCache should clear all repository data', async () => {
    const services1 = createMockServices('/repo1');
    repositoryServices.set('/repo1', services1);
    multiRepoService = new MultiRepoService(repositoryServices);
    await multiRepoService.getAggregatedData();
    assert.strictEqual(multiRepoService['cache'].size, 1);

    multiRepoService.clearCache();
    assert.strictEqual(multiRepoService['cache'].size, 0);
  });
}); 