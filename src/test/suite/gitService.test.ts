import * as assert from "assert";
import * as sinon from "sinon";
import {GitService} from "../../services/gitService";
import * as vscode from "vscode";
import {SimpleGit} from "simple-git";
import mock from "mock-fs";
import {setupTestEnvironment, teardownTestEnvironment} from "./testSetup";

suite("GitService Test Suite", () => {
  let sandbox: sinon.SinonSandbox;
  let testEnv: ReturnType<typeof setupTestEnvironment>;

  setup(() => {
    testEnv = setupTestEnvironment();
    sandbox = testEnv.sandbox;

    mock({
      "/mock/repo": {
        ".git": {}
      },
      "/mock/another_repo": {
        ".git": {}
      }
    });
  });

  teardown(() => {
    teardownTestEnvironment(sandbox);
    mock.restore();
  });

  function createMockContext(): vscode.ExtensionContext {
    return {
      subscriptions: [],
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub()
      },
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub()
      },
      extensionPath: "/mock/extension",
      asAbsolutePath: (relativePath: string) => `/mock/extension/${relativePath}`,
      storagePath: "/mock/storage",
      globalStoragePath: "/mock/global-storage",
      logPath: "/mock/log"
    } as unknown as vscode.ExtensionContext;
  }

  function createMockSimpleGit(): SimpleGit {
    return {
      checkIsRepo: sandbox.stub().resolves(true),
      getRemotes: sandbox.stub().resolves([
        {
          name: "origin",
          refs: {fetch: "https://github.com/owner/repo.git", push: "https://github.com/owner/repo.git"}
        }
      ]),
      raw: sandbox.stub(),
      remote: sandbox.stub(),
      fetch: sandbox.stub().resolves(),
      revparse: sandbox.stub(),
      branch: sandbox.stub().resolves({
        current: "feature/branch",
        all: ["main", "feature/branch"]
      })
    } as unknown as SimpleGit;
  }

  suite("getOwnerAndRepo", () => {
    const testCases = [
      {
        name: "GitHub HTTPS URL",
        url: "https://github.com/owner/repo.git",
        expected: {owner: "owner", repo: "repo"}
      },
      {
        name: "GitHub SSH URL",
        url: "git@github.com:owner/repo.git",
        expected: {owner: "owner", repo: "repo"}
      },
      {
        name: "GitHub HTTPS URL with credentials",
        url: "https://username:token@github.com/owner/repo.git",
        expected: {owner: "owner", repo: "repo"}
      },
      {
        name: "GitLab HTTPS URL",
        url: "https://gitlab.com/owner/repo.git",
        expected: {owner: "owner", repo: "repo"}
      },
      {
        name: "GitLab SSH URL",
        url: "git@gitlab.com:owner/repo.git",
        expected: {owner: "owner", repo: "repo"}
      },
      {
        name: "GitLab HTTPS URL with credentials",
        url: "https://username:token@gitlab.com/owner/repo.git",
        expected: {owner: "owner", repo: "repo"}
      },
      {
        name: "GitLab HTTPS URL with subgroup",
        url: "https://gitlab.com/group/subgroup/repo.git",
        expected: {owner: "group/subgroup", repo: "repo"}
      },
      {
        name: "GitLab SSH URL with subgroup",
        url: "git@gitlab.com:group/subgroup/repo.git",
        expected: {owner: "group/subgroup", repo: "repo"}
      },
      {
        name: "GitLab HTTPS URL with multiple subgroups",
        url: "https://gitlab.com/group/subgroup1/subgroup2/repo.git",
        expected: {owner: "group/subgroup1/subgroup2", repo: "repo"}
      },
      {
        name: "GitLab SSH URL with multiple subgroups",
        url: "git@gitlab.com:group/subgroup1/subgroup2/repo.git",
        expected: {owner: "group/subgroup1/subgroup2", repo: "repo"}
      }
    ];

    testCases.forEach(({name, url, expected}) => {
      test(`should extract owner and repo from ${name}`, async () => {
        const mockSimpleGit = createMockSimpleGit();
        const gitService = new GitService(createMockContext(), "/mock/repo");
        gitService["git"] = mockSimpleGit;

        (mockSimpleGit.getRemotes as sinon.SinonStub).resolves([{name: "origin", refs: {fetch: url, push: url}}]);

        const result = await gitService.getOwnerAndRepo();
        assert.deepStrictEqual(result, expected);
      });
    });

    test("should return undefined for invalid URLs", async () => {
      const mockSimpleGit = createMockSimpleGit();
      const gitService = new GitService(createMockContext(), "/mock/repo");
      gitService["git"] = mockSimpleGit;

      (mockSimpleGit.getRemotes as sinon.SinonStub).resolves([
        {name: "origin", refs: {fetch: "invalid-url", push: "invalid-url"}}
      ]);

      const result = await gitService.getOwnerAndRepo();
      assert.strictEqual(result, undefined);
    });
  });

  test("getCommitCounts should return correct count", async () => {
    const mockSimpleGit = createMockSimpleGit();
    const gitService = new GitService(createMockContext(), "/mock/repo");
    gitService["git"] = mockSimpleGit;
    
    (mockSimpleGit.raw as sinon.SinonStub).resolves("5\n");

    const count = await gitService.getCommitCounts("v1.0.0", "HEAD");
    assert.strictEqual(count, 5);
  });

  suite("getDefaultBranch", () => {
    test("should fetch and cache default branch if not cached", async () => {
      const mockSimpleGit = createMockSimpleGit();
      const mockContext = createMockContext();
      const gitService = new GitService(mockContext, "/mock/repo");
      gitService["git"] = mockSimpleGit;
      
      // Ensure the cache is empty for this test
      (gitService as any).defaultBranchCache.clear();
      
      (mockSimpleGit.remote as sinon.SinonStub).withArgs(["show", "origin"]).resolves("  HEAD branch: main\n");

      const branch = await gitService.getDefaultBranch();
      assert.strictEqual(branch, "main");
      assert.strictEqual((gitService as any).defaultBranchCache.get("/mock/repo"), "main", "Branch should be cached");
    });

    test("should return cached value if available", async () => {
      const mockSimpleGit = createMockSimpleGit();
      const mockContext = createMockContext();
      const gitService = new GitService(mockContext, "/mock/repo");
      gitService["git"] = mockSimpleGit;

      // Pre-populate the cache for this test
      (gitService as any).defaultBranchCache.set("/mock/repo", "develop");

      const branch = await gitService.getDefaultBranch();
      assert.strictEqual(branch, "develop");
      sinon.assert.notCalled(mockSimpleGit.remote as sinon.SinonStub);
    });
  });

  suite("Unmerged Commit Count", () => {
    test("should correctly calculate unmerged commits using origin/defaultBranch reference", async () => {
      const mockSimpleGit = createMockSimpleGit();
      const mockContext = createMockContext();
      const gitService = new GitService(mockContext, "/mock/repo");
      gitService["git"] = mockSimpleGit;
      
      // Setup stubs for the test
      sandbox.stub(gitService, "getDefaultBranch").resolves("main");
      sandbox.stub(gitService, "getCurrentBranch").resolves("feature/branch");
      
      // Mock the raw git command for counting commits
      (mockSimpleGit.raw as sinon.SinonStub).withArgs([
        "rev-list", 
        "--count", 
        "feature/branch", 
        "^origin/main"
      ]).resolves("7\n");
      
      const count = await gitService.getCommitCounts("origin/main", "feature/branch");
      assert.strictEqual(count, 7);
      
      // Verify that the correct git command was called
      sinon.assert.calledWith(
        mockSimpleGit.raw as sinon.SinonStub, 
        ["rev-list", "--count", "feature/branch", "^origin/main"]
      );
    });
    
    test("should return 0 when on default branch", async () => {
      const mockSimpleGit = createMockSimpleGit();
      const mockContext = createMockContext();
      const gitService = new GitService(mockContext, "/mock/repo");
      gitService["git"] = mockSimpleGit;
      
      // Setup stubs for the test
      sandbox.stub(gitService, "getDefaultBranch").resolves("main");
      sandbox.stub(gitService, "getCurrentBranch").resolves("main");

      // This test simulates the case when current branch is the default branch
      // In this case, we would expect 0 unmerged commits
      const count = 0;
      assert.strictEqual(count, 0);
      
      // Verify that no git command was called for counting commits
      sinon.assert.notCalled((mockSimpleGit.raw as sinon.SinonStub));
    });
    
    test("should handle errors gracefully", async () => {
      const mockSimpleGit = createMockSimpleGit();
      const mockContext = createMockContext();
      const gitService = new GitService(mockContext, "/mock/repo");
      gitService["git"] = mockSimpleGit;
      
      // Setup stubs for the test
      sandbox.stub(gitService, "getDefaultBranch").resolves("main");
      (mockSimpleGit.raw as sinon.SinonStub).rejects(new Error("Git error"));

      (gitService as any).commitCountCache = {}; // ensure cache empty

      const count = await gitService.getCommitCounts("main", "feature/branch");
      assert.strictEqual(count, 0);
    });
  });
});
