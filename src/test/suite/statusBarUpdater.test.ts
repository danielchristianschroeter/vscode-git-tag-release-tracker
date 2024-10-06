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

    gitService = {
      initializeGit: sandbox.stub().resolves(false),
      getCurrentRepo: sandbox.stub().returns('test-repo'),
      fetchAndTags: sandbox.stub().resolves({ latest: '1.0.0', all: ['1.0.0'] }),
      detectBranch: sandbox.stub().resolves(true),
      getRemotes: sandbox.stub().resolves(),
      getCurrentBranch: sandbox.stub().returns('main'),
      detectCIType: sandbox.stub().returns('github'),
      getCommits: sandbox.stub().resolves({ total: 5 }),
      getUnreleasedCommits: sandbox.stub().resolves(5),
      getOwnerAndRepo: sandbox.stub().returns({ owner: 'owner', repo: 'repo' }),
    } as unknown as GitService;

    statusBarService = {
      clearStatusBar: sandbox.stub(),
      hideBuildStatus: sandbox.stub(),
      hideBranchBuildStatus: sandbox.stub(),
      hideButtons: sandbox.stub(),
      updateButton: sandbox.stub(),
      showButtons: sandbox.stub(),
      updateStatusBar: sandbox.stub(),
      updateBuildStatus: sandbox.stub(),
      updateBranchBuildStatus: sandbox.stub(),
      setCurrentRepo: sandbox.stub(),
    } as unknown as StatusBarService;

    ciService = {
      getBuildStatus: sandbox.stub().resolves({ status: 'success', url: 'https://example.com', message: 'Build successful' }),
      getImmediateBuildStatus: sandbox.stub().resolves({ status: 'success', url: 'https://example.com', message: 'Build successful' }),
      clearCache: sandbox.stub(),
    } as unknown as CIService;

    showErrorStub = sandbox.stub(errorHandler, 'showError');
    logErrorStub = sandbox.stub(statusBarUpdaterModule, 'logError');

    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: sandbox.stub().returns({
        github: { token: 'fake-token', apiUrl: 'https://api.github.com' },
      }),
    } as any);

    sandbox.stub(vscode.commands, 'executeCommand');
  });

  teardown(() => {
    sandbox.restore();
  });

  test("updateStatusBar should update status bar correctly", async () => {
    await statusBarUpdaterModule.updateStatusBar(gitService, statusBarService, "main", ciService);

    sinon.assert.calledOnce(gitService.initializeGit as sinon.SinonStub);
    sinon.assert.calledOnce(gitService.getCurrentRepo as sinon.SinonStub);
    sinon.assert.calledOnce(gitService.fetchAndTags as sinon.SinonStub);
    sinon.assert.calledOnce(gitService.detectBranch as sinon.SinonStub);
    sinon.assert.calledOnce(gitService.getRemotes as sinon.SinonStub);
    sinon.assert.calledOnce(gitService.getCurrentBranch as sinon.SinonStub);
    sinon.assert.calledOnce(gitService.detectCIType as sinon.SinonStub);
    sinon.assert.calledOnce(gitService.getUnreleasedCommits as sinon.SinonStub);

    sinon.assert.calledOnce(statusBarService.setCurrentRepo as sinon.SinonStub);
    sinon.assert.calledOnce(statusBarService.updateStatusBar as sinon.SinonStub);
    sinon.assert.calledWith(
      statusBarService.updateStatusBar as sinon.SinonStub,
      'test-repo/main | 5 unreleased commits',
      sinon.match.string,
      'extension.openCompareLink'
    );

    sinon.assert.calledOnce(statusBarService.updateBuildStatus as sinon.SinonStub);
    sinon.assert.calledWith(
      statusBarService.updateBuildStatus as sinon.SinonStub,
      'success',
      '1.0.0',
      'https://example.com',
      'repo'
    );

    sinon.assert.calledOnce(statusBarService.updateBranchBuildStatus as sinon.SinonStub);
    sinon.assert.calledWith(
      statusBarService.updateBranchBuildStatus as sinon.SinonStub,
      'success',
      'main',
      'https://example.com',
      'repo'
    );

    sinon.assert.notCalled(showErrorStub);
    sinon.assert.notCalled(logErrorStub);
  });

  test("updateStatusBar should handle errors gracefully", async () => {
    const testError = new Error("Test error");
    (gitService.initializeGit as sinon.SinonStub).rejects(testError);

    await statusBarUpdaterModule.updateStatusBar(gitService, statusBarService, "main", ciService);

    sinon.assert.calledOnce(showErrorStub);
    sinon.assert.calledWith(showErrorStub, testError, "Error fetching git data");
    sinon.assert.calledOnce(statusBarService.clearStatusBar as sinon.SinonStub);
    sinon.assert.calledOnce(logErrorStub);
    sinon.assert.calledWith(logErrorStub, "Error updating status bar:", testError);
  });
});