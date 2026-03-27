import * as assert from "assert";
import * as sinon from "sinon";
import {CIService} from "../../services/ciService";
import axios from "axios";
import {setupTestEnvironment, teardownTestEnvironment} from "./testSetup";
import {Logger} from "../../utils/logger";

suite("CIService Test Suite", () => {
  let sandbox: sinon.SinonSandbox;
  let testEnv: ReturnType<typeof setupTestEnvironment>;

  function createGitHubHeaders(overrides: Record<string, string> = {}) {
    return {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": `${Math.floor((Date.now() + 5 * 60 * 1000) / 1000)}`,
      ...overrides
    };
  }

  function createGitLabHeaders(overrides: Record<string, string> = {}) {
    return {
      "ratelimit-limit": "5000",
      "ratelimit-remaining": "4999",
      "ratelimit-reset": "300",
      ...overrides
    };
  }

  function createGitHubRunsResponse(
    status: string,
    ref: string,
    conclusion: string | null = status === "completed" ? "success" : null,
    headers: Record<string, string> = createGitHubHeaders()
  ) {
    return {
      data: {
        total_count: 1,
        workflow_runs: [
          {
            id: 123,
            status,
            conclusion,
            html_url: "https://github.com/owner/repo/actions/runs/123",
            head_commit: {id: "1234567890abcdef"},
            head_branch: ref
          }
        ]
      },
      headers
    };
  }

  function createGitLabPipelinesResponse(
    status: string,
    ref: string,
    headers: Record<string, string> = createGitLabHeaders()
  ) {
    return {
      data: [
        {
          id: 123,
          status,
          web_url: "https://gitlab.com/owner/repo/-/pipelines/123",
          ref
        }
      ],
      headers
    };
  }

  function createGitHubRateLimitError(headers: Record<string, string>) {
    const error = new Error("Rate limit exceeded");
    (error as any).isAxiosError = true;
    (error as any).response = {
      status: 403,
      headers,
      data: {message: "API rate limit exceeded"}
    };
    return error;
  }

  setup(() => {
    testEnv = setupTestEnvironment();
    sandbox = testEnv.sandbox;
    sandbox.stub(Logger, "log");
    (CIService as any).rateLimitState = {};
  });

  teardown(() => {
    teardownTestEnvironment(sandbox);
  });

  test("getBuildStatus should return correct status for GitHub tag", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves(createGitHubRunsResponse("completed", "1.0.0"));

    const result = await ciService.getBuildStatus("1.0.0", "github", true);
    assert.strictEqual(result?.status, "success");
    assert.strictEqual(result?.url, "https://github.com/owner/repo/actions/runs/123");
    assert.strictEqual(result?.icon, "$(check)");
  });

  test("getBuildStatus should return correct status for GitHub branch", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves(createGitHubRunsResponse("completed", "main"));

    const status = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(status?.status, "success");
    assert.strictEqual(status?.url, "https://github.com/owner/repo/actions/runs/123");
    assert.strictEqual(status?.icon, "$(check)");
  });

  test("getBuildStatus should return correct status for GitLab tag", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves(createGitLabPipelinesResponse("success", "1.0.0"));

    const status = await ciService.getBuildStatus("1.0.0", "gitlab", true);

    assert.strictEqual(status?.status, "success");
    assert.ok(status?.url?.includes("pipelines/123"));
    assert.strictEqual(status?.icon, "$(check)");
  });

  test("getBuildStatus should return no_runs for GitLab when no matching pipeline is found", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves({
      data: [],
      headers: createGitLabHeaders()
    });

    const status = await ciService.getBuildStatus("1.0.0", "gitlab", true);

    assert.strictEqual(status?.status, "no_runs");
    assert.ok(status?.message?.includes("No pipeline found"));
  });

  test("getImmediateBuildStatus should bypass the cache", async () => {
    const ciService = new CIService("owner", "repo");
    const axiosStub = sandbox.stub(axios, "get");
    axiosStub.onFirstCall().resolves(createGitHubRunsResponse("completed", "main", "success"));
    axiosStub.onSecondCall().resolves(createGitHubRunsResponse("completed", "main", "failure"));

    const cached = await ciService.getBuildStatus("main", "github", false);
    const result = await ciService.getImmediateBuildStatus("main", "github", false);

    assert.strictEqual(cached?.status, "success");
    assert.strictEqual(result.status, "failure");
    assert.strictEqual(axiosStub.callCount, 2);
  });

  test("Should activate cooldown when GitHub quota is nearly exhausted", async () => {
    const ciService = new CIService("owner", "repo");
    const axiosStub = sandbox
      .stub(axios, "get")
      .resolves(
        createGitHubRunsResponse("completed", "main", "success", createGitHubHeaders({"x-ratelimit-remaining": "25"}))
      );

    const firstResult = await ciService.getBuildStatus("main", "github", false);
    const secondResult = await ciService.getBuildStatus("main", "github", false, true);

    assert.strictEqual(firstResult?.status, "success");
    assert.strictEqual(secondResult?.status, "success");
    assert.strictEqual(axiosStub.callCount, 1, "Force refresh should reuse the cached result during cooldown");
  });

  test("Should handle errors gracefully when GitService fails", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").rejects(new Error("Network error"));
    const result = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(result?.status, "error", "Status should be 'error'");
    assert.strictEqual(result?.message, "An unexpected error occurred: Network error", "Message should be correct");
    assert.strictEqual(result?.url, undefined, "URL should be undefined on error");
  });

  test("Should handle GitLab CI type correctly", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves(createGitLabPipelinesResponse("success", "main"));
    const result = await ciService.getBuildStatus("main", "gitlab", false);
    assert.strictEqual(result?.status, "success");
  });

  test("Should handle no CI configuration", async () => {
    const ciService = new CIService("owner", "repo");
    (ciService as any).providers = {};
    const result = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(result?.status, "unknown");
  });

  test("Should reuse cached data after GitHub rate limiting", async () => {
    const ciService = new CIService("owner", "repo");
    const resetHeader = createGitHubHeaders({"x-ratelimit-remaining": "0"});
    const axiosStub = sandbox.stub(axios, "get");
    axiosStub.onFirstCall().resolves(createGitHubRunsResponse("completed", "main", "success"));
    axiosStub.onSecondCall().rejects(createGitHubRateLimitError(resetHeader));

    const firstResult = await ciService.getBuildStatus("main", "github", false);
    const secondResult = await ciService.getBuildStatus("main", "github", false, true);
    const thirdResult = await ciService.getBuildStatus("main", "github", false, true);

    assert.strictEqual(firstResult?.status, "success");
    assert.strictEqual(secondResult?.status, "success");
    assert.strictEqual(thirdResult?.status, "success");
    assert.strictEqual(axiosStub.callCount, 2, "Cooldown should skip the third network request");
  });

  test("Should handle tag creation", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves({
      data: {
        total_count: 1,
        workflow_runs: [
          {
            id: 123,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/owner/repo/actions/runs/123",
            head_branch: "v1.0.1",
            head_commit: {
              id: "v1.0.1"
            }
          }
        ]
      },
      headers: {}
    });
    const result = await ciService.getBuildStatus("v1.0.1", "github", true);
    assert.strictEqual(result?.status, "success");
  });

  test("clearCacheForBranch should result in a new network request", async () => {
    const ciService = new CIService("owner", "repo");
    const axiosStub = sandbox.stub(axios, "get").resolves(createGitHubRunsResponse("completed", "main"));

    // First call, should use network and populate cache
    await ciService.getBuildStatus("main", "github", false);
    assert.ok(axiosStub.calledOnce, "Axios should be called the first time");

    // Second call, should be cached
    await ciService.getBuildStatus("main", "github", false);
    assert.ok(axiosStub.calledOnce, "Axios should not be called the second time (cached)");

    // Clear cache
    ciService.clearCacheForBranch("main", "github");

    // Third call, should use network again
    await ciService.getBuildStatus("main", "github", false);
    assert.ok(axiosStub.calledTwice, "Axios should be called again after cache is cleared");
  });

  test("getBuildStatus should return correct status for GitHub in_progress workflow", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves(createGitHubRunsResponse("in_progress", "main", null));

    const result = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(result?.status, "in_progress");
    assert.strictEqual(result?.url, "https://github.com/owner/repo/actions/runs/123");
  });

  test("getBuildStatus should return correct status for GitHub pending workflow", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves(createGitHubRunsResponse("queued", "main", null));

    const result = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(result?.status, "queued");
    assert.strictEqual(result?.url, "https://github.com/owner/repo/actions/runs/123");
  });

  test("getBuildStatus should return correct status for GitLab running pipeline", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves(createGitLabPipelinesResponse("running", "main"));

    const result = await ciService.getBuildStatus("main", "gitlab", false);
    assert.strictEqual(result?.status, "in_progress");
    assert.ok(result?.url?.includes("pipelines/123"));
  });

  test("getBuildStatus should return correct status for GitLab pending pipeline", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves({
      data: [
        {
          id: 123,
          status: "pending",
          web_url: "https://gitlab.com/owner/repo/-/pipelines/123",
          ref: "main"
        }
      ],
      headers: {}
    });

    const result = await ciService.getBuildStatus("main", "gitlab", false);
    assert.strictEqual(result?.status, "pending");
    assert.ok(result?.url?.includes("pipelines/123"));
  });

  test("getCompareUrl should generate correct URL for GitHub", () => {
    const ciService = new CIService("owner", "repo");
    const result = ciService.getCompareUrl("v1.0.0", "main", "github");
    assert.strictEqual(result.url, "https://github.com/owner/repo/compare/v1.0.0...main");
    assert.strictEqual(result.status, "success");
  });

  test("getCompareUrl should generate correct URL for GitLab", () => {
    const ciService = new CIService("owner", "repo");
    const result = ciService.getCompareUrl("v1.0.0", "main", "gitlab");
    assert.strictEqual(result.url, "https://gitlab.com/owner/repo/-/compare/v1.0.0...main");
    assert.strictEqual(result.status, "success");
  });

  test("getCompareUrl should handle errors gracefully", () => {
    const ciService = new CIService("owner", "repo");
    const result = ciService.getCompareUrl("v1.0.0", "main", "unknown" as any);
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "Unsupported CI type: unknown");
  });
});
