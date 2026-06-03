import * as sinon from "sinon";
import * as vscode from "vscode";
import {activate} from "../../extension";
import {globals} from "../../globals";

suite("Activation Test Suite", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    globals.context = null;
    globals.repositoryServices.clear();
    globals.statusBarService = null;
    globals.isInitialized = false;
  });

  teardown(() => {
    sandbox.restore();
    globals.context = null;
    globals.repositoryServices.clear();
    globals.statusBarService = null;
    globals.isInitialized = false;
  });

  test("does not create status bar items when startup activation finds no repositories", async () => {
    const clock = sandbox.useFakeTimers();
    const context = {subscriptions: []} as unknown as vscode.ExtensionContext;
    const disposable = {dispose: sandbox.stub()};
    const gitApi = {
      state: "initialized",
      repositories: [],
      onDidOpenRepository: sandbox.stub().returns(disposable),
      onDidCloseRepository: sandbox.stub().returns(disposable)
    };

    sandbox.stub(vscode.extensions, "getExtension").withArgs("vscode.git").returns({
      isActive: true,
      exports: {
        getAPI: () => gitApi
      }
    } as any);
    sandbox.stub(vscode.window, "createOutputChannel").returns({
      appendLine: sandbox.stub(),
      show: sandbox.stub()
    } as any);
    sandbox.stub(vscode.window, "showErrorMessage").resolves(undefined as any);
    sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined as any);
    const createStatusBarItem = sandbox.stub(vscode.window, "createStatusBarItem").returns({
      show: sandbox.stub(),
      hide: sandbox.stub(),
      dispose: sandbox.stub()
    } as any);
    sandbox.stub(vscode.workspace, "onDidChangeConfiguration").returns(disposable);
    sandbox.stub(vscode.workspace, "onDidChangeWorkspaceFolders").returns(disposable);
    sandbox.stub(vscode.workspace, "onDidSaveTextDocument").returns(disposable);
    sandbox.stub(vscode.commands, "registerCommand").returns(disposable);

    await activate(context);
    await clock.tickAsync(600);

    sinon.assert.notCalled(createStatusBarItem);
  });
});
