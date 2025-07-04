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
  let gitService: GitService;
  let mockSimpleGit: SimpleGit;

  setup(() => {
    testEnv = setupTestEnvironment();
    sandbox = testEnv.sandbox;

    // Mock vscode.workspace.workspaceFolders
    sandbox.stub(vscode.workspace, "workspaceFolders").value([{uri: {fsPath: "/mock/repo"}}] as any);

    // Mock simple-git
    mockSimpleGit = {
      checkIsRepo: sandbox.stub().resolves(true),
      getRemotes: sandbox.stub().resolves([
        {
          name: "origin",
          refs: {fetch: "https://github.com/owner/repo.git", push: "https://github.com/owner/repo.git"}
        }
      ])
      // Add other methods you need to mock
    } as unknown as SimpleGit;

    // Mock the file system
    mock({
      "/mock/repo": {
        ".git": {} // Simulate a git repository
      }
    });

    // Create a mock vscode.ExtensionContext
    const mockContext: vscode.ExtensionContext = {
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

    // Initialize GitService with the mocked simple-git and context
    gitService = new GitService(mockContext);
    gitService["git"] = mockSimpleGit;
  });

  teardown(() => {
    teardownTestEnvironment(sandbox);
    mock.restore();
  });

  suite("getOwnerAndRepo", () => {
    // Individual test cases
    test("should return undefined for invalid URLs", async () => {
      (mockSimpleGit.getRemotes as sinon.SinonStub).resolves([
        {name: "origin", refs: {fetch: "invalid-url", push: "invalid-url"}}
      ]);

      const result = await gitService.getOwnerAndRepo();
      assert.strictEqual(result, undefined);
    });

    test("should handle GitHub Enterprise URLs", async () => {
      (mockSimpleGit.getRemotes as sinon.SinonStub).resolves([
        {
          name: "origin",
          refs: {
            fetch: "https://github.mycompany.com/owner/repo.git",
            push: "https://github.mycompany.com/owner/repo.git"
          }
        }
      ]);

      const result = await gitService.getOwnerAndRepo();
      assert.deepStrictEqual(result, {owner: "owner", repo: "repo"});
    });

    test("should handle GitLab self-hosted URLs", async () => {
      (mockSimpleGit.getRemotes as sinon.SinonStub).resolves([
        {
          name: "origin",
          refs: {
            fetch: "https://gitlab.mycompany.com/group/repo.git",
            push: "https://gitlab.mycompany.com/group/repo.git"
          }
        }
      ]);

      const result = await gitService.getOwnerAndRepo();
      assert.deepStrictEqual(result, {owner: "group", repo: "repo"});
    });

    test("should return undefined when git is not initialized", async () => {
      (mockSimpleGit.checkIsRepo as sinon.SinonStub).resolves(false);
      (mockSimpleGit.getRemotes as sinon.SinonStub).resolves([]); // Ensure no remotes are returned

      const result = await gitService.getOwnerAndRepo();
      assert.strictEqual(result, undefined);
    });

    // Array of test cases
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
      test(`getOwnerAndRepo should extract owner and repo from ${name}`, async () => {
        (mockSimpleGit.getRemotes as sinon.SinonStub).resolves([{name: "origin", refs: {fetch: url, push: url}}]);

        const result = await gitService.getOwnerAndRepo();
        assert.deepStrictEqual(result, expected);
      });
    });
  });

  test("getCommitCounts should return correct count for unreleased commits", async () => {
    const gitStub = {
      raw: sandbox.stub().resolves("5"),
      fetch: sandbox.stub().resolves()
    };
    (gitService as any).git = gitStub;
    (gitService as any).refExists = sandbox.stub().resolves(true);

    const count = await gitService.getCommitCounts("v1.0.0", "HEAD");
    assert.strictEqual(count, 5);
  });

  test("getCommitCounts should return total commit count when from is null", async () => {
    const gitStub = {
      raw: sandbox.stub().resolves("10"),
      fetch: sandbox.stub().resolves()
    };
    (gitService as any).git = gitStub;
    (gitService as any).refExists = sandbox.stub().resolves(true);

    const count = await gitService.getCommitCounts(null, "HEAD");
    assert.strictEqual(count, 10);
  });

  suite("getDefaultBranch", () => {
    test("should return cached value if available", async () => {
      (gitService as any).defaultBranchCache.set("testRepo", "origin/main");
      (gitService as any).activeRepository = "testRepo";
      sandbox.stub(gitService, "getCurrentRepo").resolves("testRepo");

      const branch = await gitService.getDefaultBranch();
      assert.strictEqual(branch, "origin/main");
    });

    test("should fetch and cache default branch if not cached", async () => {
      const gitStub = {
        raw: sandbox.stub().resolves("HEAD branch: main") // Simulate fetching the default branch
      };
      (gitService as any).git = gitStub;
      (gitService as any).activeRepository = "testRepo";
      (gitService as any).defaultBranchCache.clear(); // Clear the cache
      sandbox.stub(gitService, "getCurrentRepo").resolves("testRepo");

      const branch = await gitService.getDefaultBranch();
      assert.strictEqual(branch, "origin/main");
      sinon.assert.calledWith(gitStub.raw, ["remote", "show", "origin"]);
      assert.strictEqual((gitService as any).defaultBranchCache.get("testRepo"), "origin/main");
    });

    test("should return current branch if no default branch is found via remote", async () => {
      const gitStub = {
        raw: sandbox
          .stub()
          .onFirstCall()
          .resolves("HEAD branch: ") // Simulate no default branch found in remote show
          .onSecondCall()
          .rejects(new Error("Branch not found")) // Simulate rev-parse failing for main
          .onThirdCall()
          .rejects(new Error("Branch not found")) // Simulate rev-parse failing for master
          .onCall(3)
          .rejects(new Error("Branch not found")), // Simulate rev-parse failing for develop
        revparse: sandbox.stub().resolves("feature-branch") // Simulate getting the current branch
      };
      (gitService as any).git = gitStub;
      (gitService as any).activeRepository = "testRepo";
      (gitService as any).defaultBranchCache.clear();
      sandbox.stub(gitService, "getCurrentRepo").resolves("testRepo");

      const branch = await gitService.getDefaultBranch();
      assert.strictEqual(branch, "feature-branch");
      assert.strictEqual((gitService as any).defaultBranchCache.get("testRepo"), "feature-branch");
    });

    test("should return null if git is not initialized", async () => {
      (gitService as any).git = null;

      const branch = await gitService.getDefaultBranch();
      assert.strictEqual(branch, null);
    });
  });
});
