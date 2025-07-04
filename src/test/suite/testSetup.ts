import * as sinon from "sinon";
import * as vscode from "vscode";
import {Logger} from "../../utils/logger";

export function setupTestEnvironment() {
  const sandbox = sinon.createSandbox();

  // Mock the vscode API
  const outputChannelMock = {
    appendLine: sandbox.stub(),
    show: sandbox.stub()
  };

  sandbox.stub(vscode.window, "createOutputChannel").returns(outputChannelMock as any);

  const mockConfig = {
    get: sandbox.stub().returns({
      github: {token: "mock-token", apiUrl: "https://api.github.com"},
      gitlab: {token: "mock-token", apiUrl: "https://gitlab.com/api/v4"}
    }),
    has: sandbox.stub(),
    inspect: sandbox.stub(),
    update: sandbox.stub().resolves()
  };
  sandbox.stub(vscode.workspace, "getConfiguration").returns(mockConfig as any);

  // Initialize the Logger with a mock context
  const contextMock = {subscriptions: []} as any;
  Logger.initialize(contextMock);

  return {sandbox, outputChannelMock};
}

export function teardownTestEnvironment(sandbox: sinon.SinonSandbox) {
  if (sandbox) {
    sandbox.restore();
  }
}
