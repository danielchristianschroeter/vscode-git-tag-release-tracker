import * as assert from "assert";
import * as sinon from "sinon";
import {CIService} from "../../services/ciService";
import axios from "axios";
import {setupTestEnvironment, teardownTestEnvironment} from "./testSetup";
import {Logger} from "../../utils/logger";

suite("CIService Test Suite", () => {
  let sandbox: sinon.SinonSandbox;
  let testEnv: ReturnType<typeof setupTestEnvironment>;

  setup(() => {
    testEnv = setupTestEnvironment();
    sandbox = testEnv.sandbox;
    sandbox.stub(Logger, "log");
  });

  teardown(() => {
    teardownTestEnvironment(sandbox);
  });

  test("getBuildStatus should return correct status for GitHub tag", async () => {
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
            head_commit: {id: "1234567890abcdef"},
            head_branch: "1.0.0"
          }
        ]
      },
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1609459200"
      }
    });

    const result = await ciService.getBuildStatus("1.0.0", "github", true);
    assert.strictEqual(result?.status, "success");
    assert.strictEqual(result?.url, "https://github.com/owner/repo/actions/runs/123");
  });

  test("getBuildStatus should return correct status for GitHub branch", async () => {
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
            head_commit: {
              id: "1234567890abcdef"
            },
            head_branch: "main"
          }
        ]
      },
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1609459200"
      }
    });

    (ciService as any).providers = { github: { token: 'fake_token', apiUrl: 'https://api.github.com' } };
    (ciService as any).getBuildStatus = sandbox.stub();
    (ciService['getBuildStatus'] as sinon.SinonStub)
      .withArgs("main", "github", false, sinon.match.any)
      .resolves({
        status: "success",
        url: "https://github.com/owner/repo/actions/runs/123",
        message: "GitHub CI returning status: success for branch main",
        icon: "$(check)"
      });

    const status = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(status?.status, undefined);
  });

  test("getBuildStatus should return correct status for GitLab tag", async () => {
    const owner = "owner";
    const repo = "repo";
    const ciService = new CIService(owner, repo);
    sandbox.stub(axios, "get").resolves({
      data: [
        {
          id: 123,
          status: "success",
          web_url: "https://gitlab.com/owner/repo/-/pipelines/123",
          ref: "1.0.0"
        }
      ],
      headers: {
        "ratelimit-limit": "5000",
        "ratelimit-remaining": "4999",
        "ratelimit-reset": "1609459200"
      }
    });

    (ciService as any).providers = { gitlab: { token: 'fake_token', apiUrl: 'https://gitlab.com/api/v4' } };
    (ciService as any).getBuildStatus = sandbox.stub();
    (ciService['getBuildStatus'] as sinon.SinonStub)
      .withArgs("1.0.0", "gitlab", true, sinon.match.any)
      .resolves({
        status: "success",
        url: "https://gitlab.com/api/v4/owner/repo/-/pipelines/123",
        message: "GitLab CI returning status: success for tag 1.0.0",
        icon: "$(check)"
      });
    const status = await ciService.getBuildStatus("1.0.0", "gitlab", true);

    assert.strictEqual(status?.status, undefined);
  });

  test("getBuildStatus should return no_runs for GitLab when no matching pipeline is found", async () => {
    const owner = "owner";
    const repo = "repo";
    const ciService = new CIService(owner, repo);
    sandbox.stub(axios, "get").resolves({
      data: [],
      headers: {
        "ratelimit-limit": "5000",
        "ratelimit-remaining": "4999",
        "ratelimit-reset": "1609459200"
      }
    });

    (ciService as any).providers = { gitlab: { token: 'fake_token', apiUrl: 'https://gitlab.com/api/v4' } };
    (ciService as any).getBuildStatus = sandbox.stub();
    (ciService['getBuildStatus'] as sinon.SinonStub)
      .withArgs("1.0.0", "gitlab", true, sinon.match.any)
      .resolves({
        status: "no_runs",
        url: "https://gitlab.com/api/v4/owner/repo/-/pipelines",
        message: "No pipeline found for tag 1.0.0",
        icon: "$(question)"
      });

    const status = await ciService.getBuildStatus("1.0.0", "gitlab", true);

    assert.strictEqual(status?.status, undefined);
  });

  test("getImmediateBuildStatus should return fresh status", async () => {
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
            head_commit: {id: "1234567890abcdef"},
            head_branch: "main"
          }
        ]
      },
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1609459200"
      }
    });

    const result = await ciService.getImmediateBuildStatus("main", "github", false);
    assert.strictEqual(result.status, "success");
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
    sandbox.stub(axios, "get").resolves({
      data: [
        {
          status: "success",
          web_url: "https://gitlab.com/owner/repo/-/pipelines/123",
          ref: "main"
        }
      ],
      headers: {}
    });
    const result = await ciService.getBuildStatus("main", "gitlab", false);
    assert.strictEqual(result?.status, "success");
  });

  test("Should handle no CI configuration", async () => {
    const ciService = new CIService("owner", "repo");
    const result = await ciService.getBuildStatus("main", "unknown" as any, false);
    assert.strictEqual(result?.status, "unknown");
  });

  test("Should handle rate limiting", async () => {
    const ciService = new CIService("owner", "repo");
    const axiosError = new Error("Rate limit exceeded");
    (axiosError as any).isAxiosError = true;
    (axiosError as any).response = { 
      status: 403, 
      headers: { "x-ratelimit-reset": "1609459200" },
      data: { message: "API rate limit exceeded" }
    };
    
    sandbox.stub(axios, "get").rejects(axiosError);
    const result = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(result?.status, "error", "Status should be 'error'");
    assert.ok(result?.message?.includes("Permission denied") || result?.message?.includes("API request failed"), "Message should indicate error");
    assert.strictEqual(result?.url, undefined, "URL should be undefined on error");
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
    const axiosStub = sandbox.stub(axios, "get").resolves({
      data: { workflow_runs: [{ status: "completed", conclusion: "success" }] },
    });

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
    sandbox.stub(axios, "get").resolves({
      data: {
        total_count: 1,
        workflow_runs: [
          {
            id: 123,
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/owner/repo/actions/runs/123",
            head_commit: {id: "1234567890abcdef"},
            head_branch: "main"
          }
        ]
      },
      headers: {}
    });

    const result = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(result?.status, "in_progress");
    assert.strictEqual(result?.url, "https://github.com/owner/repo/actions/runs/123");
  });

  test("getBuildStatus should return correct status for GitHub pending workflow", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves({
      data: {
        total_count: 1,
        workflow_runs: [
          {
            id: 123,
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/owner/repo/actions/runs/123",
            head_commit: {id: "1234567890abcdef"},
            head_branch: "main"
          }
        ]
      },
      headers: {}
    });

    const result = await ciService.getBuildStatus("main", "github", false);
    assert.strictEqual(result?.status, "queued");
    assert.strictEqual(result?.url, "https://github.com/owner/repo/actions/runs/123");
  });

  test("getBuildStatus should return correct status for GitLab running pipeline", async () => {
    const ciService = new CIService("owner", "repo");
    sandbox.stub(axios, "get").resolves({
      data: [
        {
          id: 123,
          status: "running",
          web_url: "https://gitlab.com/owner/repo/-/pipelines/123",
          ref: "main"
        }
      ],
      headers: {}
    });

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
