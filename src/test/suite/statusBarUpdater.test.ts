import * as sinon from "sinon";
import assert from "assert";
import * as statusBarUpdaterModule from "../../utils/statusBarUpdater";
import { GitService } from "../../services/gitService";
import { StatusBarService } from "../../services/statusBarService";
import { CIService } from "../../services/ciService";
import * as vscode from "vscode";
import * as errorHandler from "../../utils/errorHandler";

suite("StatusBarUpdater Test Suite", () => {
  let gitService: GitService;
  let statusBarService: StatusBarService;
  let ciService: CIService;
  let sandbox: sinon.SinonSandbox;
  let showErrorStub: sinon.SinonStub;
  let logErrorStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create stub objects instead of actual instances
    gitService = {
      initializeGit: sandbox.stub().resolves(true),
      getCurrentBranch: sandbox.stub().returns("main"),
      getCurrentRepo: sandbox.stub().returns("test-repo"),
      fetchAndTags: sandbox
        .stub()
        .resolves({ latest: "1.0.0", all: ["1.0.0"] }),
      getUnreleasedCommits: sandbox.stub().resolves(5),
      getOwnerAndRepo: sandbox
        .stub()
        .resolves({ owner: "owner", repo: "repo" }),
      detectBranch: sandbox.stub().resolves(true),
      getRemotes: sandbox
        .stub()
        .resolves([
          {
            name: "origin",
            refs: { fetch: "https://github.com/owner/repo.git" },
          },
        ]),
      getRemoteUrl: sandbox
        .stub()
        .resolves("https://github.com/owner/repo.git"),
      detectCIType: sandbox.stub().returns(null),
    } as any;

    statusBarService = {
      updateStatusBar: sandbox.stub(),
      updateButton: sandbox.stub(),
      renderBuildStatus: sandbox.stub(),
      hideBuildStatus: sandbox.stub(),
      hideButtons: sandbox.stub(),
      showButtons: sandbox.stub(),
      getLastCheckedBuildStatus: sandbox.stub(),
      getLastBuildStatus: sandbox.stub(),
      clearStatusBar: sandbox.stub(),
      updateBuildStatus: sandbox.stub(),
      setCIConfigured: sandbox.stub(),
    } as any;

    ciService = {
      getBuildStatus: sandbox
        .stub()
        .resolves({ status: "success", url: "https://example.com" }),
    } as any;

    // Stub showError only once
    showErrorStub = sandbox.stub(errorHandler, "showError").resolves(undefined);
    logErrorStub = sandbox.stub(statusBarUpdaterModule, "logError");

    // Mock the configuration
    sandbox.stub(statusBarUpdaterModule, 'getConfiguration').returns({
      get: (key: string) => {
        if (key === 'ciProviders') {
          return {};
        }
        return undefined;
      },
      has: (key: string) => key === 'ciProviders',
      inspect: () => undefined,
      update: sandbox.stub().resolves(),
    } as vscode.WorkspaceConfiguration);
  });

  teardown(() => {
    sandbox.restore();
  });

  test("updateStatusBar should update status bar correctly", async () => {
    await statusBarUpdaterModule.updateStatusBar(gitService, statusBarService, "main", ciService);

    sinon.assert.called(statusBarService.updateStatusBar as sinon.SinonStub);
    
    const updateStatusBarCall = (statusBarService.updateStatusBar as sinon.SinonStub).getCall(0);
    assert(updateStatusBarCall, "updateStatusBar should have been called");
    assert(updateStatusBarCall.args[0].includes("test-repo/main"), "Status bar text should include repo and branch");
    assert(updateStatusBarCall.args[0].includes("5 unreleased commits"), "Status bar text should include unreleased commits");
    assert(updateStatusBarCall.args[0].includes("1.0.0"), "Status bar text should include latest tag");

    // Verify that other methods were called as expected
    sinon.assert.called(gitService.initializeGit as sinon.SinonStub);
    sinon.assert.called(gitService.getCurrentRepo as sinon.SinonStub);
    sinon.assert.called(gitService.fetchAndTags as sinon.SinonStub);
    sinon.assert.called(gitService.detectBranch as sinon.SinonStub);
    sinon.assert.called(gitService.getRemotes as sinon.SinonStub);
    sinon.assert.called(gitService.getCurrentBranch as sinon.SinonStub);
    sinon.assert.called(gitService.getUnreleasedCommits as sinon.SinonStub);
  });

  test("updateStatusBar should handle errors gracefully", async () => {
    const testError = new Error("Test error");
    (gitService.initializeGit as sinon.SinonStub).rejects(testError);

    await statusBarUpdaterModule.updateStatusBar(gitService, statusBarService, "main", ciService);

    assert(logErrorStub.calledOnce, "logError should be called once");
    assert(
      logErrorStub.calledWith("Error updating status bar:", testError),
      "logError should be called with the correct arguments"
    );
    assert(
      (statusBarService.clearStatusBar as sinon.SinonStub).calledOnce,
      "clearStatusBar should be called once"
    );
    assert(showErrorStub.calledOnce, "showError should be called once");

    const showErrorCall = showErrorStub.getCall(0);
    assert(
      showErrorCall.args[0] instanceof Error,
      "First argument to showError should be an Error"
    );
    assert.strictEqual(
      showErrorCall.args[0].message,
      "Test error",
      "Error message should match"
    );
    assert.strictEqual(
      showErrorCall.args[1],
      "Error fetching git data",
      "Error context should match"
    );
  });

  // Add more tests as needed for different scenarios
});
