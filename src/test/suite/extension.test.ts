import * as sinon from "sinon";
import * as vscode from "vscode";
import * as assert from "assert";
import {GitService} from "../../services/gitService";
import {CIService} from "../../services/ciService";
import {StatusBarService} from "../../services/statusBarService";
import {setupTestEnvironment, teardownTestEnvironment} from "./testSetup";
import {updateStatusBar} from "../../utils/statusBarUpdater";
import { RepositoryServices } from "../../globals";
import { WorkspaceService } from "../../services/workspaceService";
import { MultiRepoService } from "../../services/multiRepoService";

suite("Extension Test Suite", () => {
  let sandbox: sinon.SinonSandbox;
  let testEnv: ReturnType<typeof setupTestEnvironment>;
  let gitService: sinon.SinonStubbedInstance<GitService>;
  let ciService: sinon.SinonStubbedInstance<CIService>;
  let statusBarService: sinon.SinonStubbedInstance<StatusBarService>;
  let workspaceService: sinon.SinonStubbedInstance<WorkspaceService>;
  let multiRepoService: sinon.SinonStubbedInstance<MultiRepoService>;

  setup(() => {
    testEnv = setupTestEnvironment();
    sandbox = testEnv.sandbox;

    gitService = sandbox.createStubInstance(GitService);
    ciService = sandbox.createStubInstance(CIService);
    statusBarService = sandbox.createStubInstance(StatusBarService);
    workspaceService = sandbox.createStubInstance(WorkspaceService);
    multiRepoService = sandbox.createStubInstance(MultiRepoService);

    // Setup default stub behaviors
    gitService.initialize.resolves(true);
    gitService.getCurrentRepo.resolves("test-repo");
    gitService.getLatestTag.resolves({latest: "1.0.0"});
    gitService.getCurrentBranch.resolves("main");
    gitService.detectCIType.returns("github");
    gitService.getOwnerAndRepo.resolves({owner: "testowner", repo: "testrepo"});

    ciService.getBuildStatus.resolves({status: "success", url: "http://example.com"});
    
    // Mock the repository services map
    const repositoryServices = new Map<string, RepositoryServices>();
    repositoryServices.set("/mock/repo1", {
      gitService,
      ciService
    });
    
    // Setup workspace service
    workspaceService.getGitRepositoryRoots.resolves(["/mock/repo1"]);
    
    // Setup multi-repo service
    multiRepoService.getAggregatedData.resolves({
      totalUnreleasedCommits: 5,
      totalUnmergedCommits: 3,
      repoData: [
        {
          repoRoot: "/mock/repo1",
          currentBranch: "main",
          defaultBranch: "main",
          latestTag: { latest: "1.0.0" },
          unreleasedCount: 5,
          unmergedCount: 3,
          ownerAndRepo: { owner: "testowner", repo: "testrepo" },
          hasRemote: true,
          branchBuildStatus: { status: "success", url: "http://example.com" },
          ciType: "github"
        }
      ]
    });
    
    // Setup status bar service
    statusBarService.updateEverything.resolves();
  });

  teardown(() => {
    teardownTestEnvironment(sandbox);
  });

  test("StatusBarService should update everything", async () => {
    await updateStatusBar(gitService, statusBarService);

    sinon.assert.calledOnce(statusBarService.updateEverything);
  });

  test("StatusBarService should update status bar with loading indicator first", async () => {
    // Create a real StatusBarService instance with mocked dependencies
    const contextStub = {
      subscriptions: []
    } as unknown as vscode.ExtensionContext;
    
    const repositoryServices = new Map<string, RepositoryServices>();
    repositoryServices.set("/mock/repo1", {
      gitService,
      ciService
    });
    
    // Mock vscode.window.createStatusBarItem
    sandbox.stub(vscode.window, "createStatusBarItem").returns({
      hide: sandbox.stub(),
      show: sandbox.stub(),
      dispose: sandbox.stub(),
      text: "",
      tooltip: undefined,
      command: undefined
    } as unknown as vscode.StatusBarItem);
    
    // Create the real service with mocked dependencies
    const realStatusBarService = new StatusBarService(contextStub, repositoryServices);
    
    // Mock the multiRepoService within the StatusBarService
    sandbox.stub((realStatusBarService as any).multiRepoService, 'getAggregatedData').resolves({
      totalUnreleasedCommits: 5,
      totalUnmergedCommits: 3,
      repoData: [
        {
          repoRoot: "/mock/repo1",
          currentBranch: "main",
          defaultBranch: "main",
          latestTag: { latest: "1.0.0" },
          unreleasedCount: 5,
          unmergedCount: 3,
          ownerAndRepo: { owner: "testowner", repo: "testrepo" },
          hasRemote: true,
          branchBuildStatus: { status: "success", url: "http://example.com" },
          ciType: "github"
        }
      ]
    });
    
    // Spy on the showLoadingIndicator method
    const showLoadingIndicatorSpy = sandbox.spy(realStatusBarService as any, 'showLoadingIndicator');
    
    // Call updateEverything
    await realStatusBarService.updateEverything(true);
    
    // Assert that showLoadingIndicator was called
    sinon.assert.calledOnce(showLoadingIndicatorSpy);
    
    // Verify loading indicator is turned off after update
    assert.strictEqual((realStatusBarService as any).isLoading, false);
  });

  test("MultiRepoService should aggregate data from all repositories", async () => {
    // Setup repository services map
    const repositoryServices = new Map<string, RepositoryServices>();

    // Setup repo1 services (on default branch)
    const repo1GitService = sandbox.createStubInstance(GitService);
    const repo1CiService = sandbox.createStubInstance(CIService);
    repo1GitService.getCurrentBranch.resolves("main");
    repo1GitService.getDefaultBranch.resolves("main");
    repo1GitService.getLatestTag.resolves({latest: "1.0.0"});
    repo1GitService.hasRemote.resolves(true);
    repo1GitService.getCommitCounts.withArgs("1.0.0", "main", sinon.match.any).resolves(5);
    repo1GitService.getOwnerAndRepo.resolves({owner: "owner1", repo: "repo1"});
    repo1GitService.detectCIType.returns("github");
    repo1CiService.getBuildStatus.resolves({status: "success", url: "https://github.com/owner1/repo1/actions/runs/123"});

    // Setup repo2 services (on feature branch)
    const repo2GitService = sandbox.createStubInstance(GitService);
    const repo2CiService = sandbox.createStubInstance(CIService);
    repo2GitService.getCurrentBranch.resolves("feature/branch");
    repo2GitService.getDefaultBranch.resolves("develop");
    repo2GitService.getLatestTag.resolves({latest: "2.0.0"});
    repo2GitService.hasRemote.resolves(true);
    // Stub for unreleased commits on the default branch (develop)
    repo2GitService.getCommitCounts.withArgs("2.0.0", "develop", sinon.match.any).resolves(3);
    // Stub for unmerged commits on the feature branch
    repo2GitService.getCommitCounts.withArgs("develop", "feature/branch", sinon.match.any).resolves(7);
    repo2GitService.getOwnerAndRepo.resolves({owner: "owner2", repo: "repo2"});
    repo2GitService.detectCIType.returns("gitlab");
    repo2CiService.getBuildStatus.resolves({status: "in_progress", url: "https://gitlab.com/owner2/repo2/-/pipelines/456"});

    repositoryServices.set("/mock/repo1", {gitService: repo1GitService, ciService: repo1CiService});
    repositoryServices.set("/mock/repo2", {gitService: repo2GitService, ciService: repo2CiService});

    // Create a real MultiRepoService with the repository services map
    const realMultiRepoService = new MultiRepoService(repositoryServices);

    // Call getAggregatedData
    const result = await realMultiRepoService.getAggregatedData();

    // Assertions
    assert.strictEqual(result.repoData.length, 2, "Should have data for two repositories");
    assert.strictEqual(result.totalUnreleasedCommits, 8, "Total unreleased should be 8 (5 from repo1 + 3 from repo2)");
    assert.strictEqual(result.totalUnmergedCommits, 7, "Total unmerged should be 7 from repo2");

    // Check repo1 data
    const repo1Data = result.repoData.find(data => data.repoRoot === "/mock/repo1");
    assert.ok(repo1Data, "Repo1 data should exist");
    assert.strictEqual(repo1Data?.currentBranch, "main");
    assert.strictEqual(repo1Data?.latestTag?.latest, "1.0.0");
    assert.strictEqual(repo1Data?.unreleasedCount, 5, "Repo1 unreleased count should be 5");
    assert.strictEqual(repo1Data?.unmergedCount, 0, "Repo1 unmerged count should be 0");
    assert.strictEqual(repo1Data?.branchBuildStatus?.status, "success");

    // Check repo2 data
    const repo2Data = result.repoData.find(data => data.repoRoot === "/mock/repo2");
    assert.ok(repo2Data, "Repo2 data should exist");
    assert.strictEqual(repo2Data?.currentBranch, "feature/branch");
    assert.strictEqual(repo2Data?.latestTag?.latest, "2.0.0");
    assert.strictEqual(repo2Data?.unreleasedCount, 3, "Repo2 unreleased count should be 3");
    assert.strictEqual(repo2Data?.unmergedCount, 7, "Repo2 unmerged count should be 7");
    assert.strictEqual(repo2Data?.branchBuildStatus?.status, "in_progress");
  });
});
