import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";
import * as vscode from "vscode";
import {WorkspaceService} from "../../services/workspaceService";

suite("WorkspaceService Test Suite", () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test("does not show a notification when no Git repositories are found", async () => {
    const showInformationMessage = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined as any);
    sandbox.stub(vscode.extensions, "getExtension").withArgs("vscode.git").returns({
      isActive: true,
      exports: {
        getAPI: () => ({repositories: []})
      }
    } as any);

    const roots = await new WorkspaceService().getGitRepositoryRoots();

    assert.deepStrictEqual(roots, []);
    sinon.assert.notCalled(showInformationMessage);
  });

  test("falls back to scanning workspace folders for nested Git repositories", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "git-tag-release-tracker-"));
    const repoA = path.join(workspaceRoot, "api");
    const repoB = path.join(workspaceRoot, "web");
    fs.mkdirSync(path.join(repoA, ".git"), {recursive: true});
    fs.mkdirSync(path.join(repoB, ".git"), {recursive: true});
    fs.writeFileSync(path.join(repoA, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(repoB, ".git", "HEAD"), "ref: refs/heads/main\n");

    sandbox.stub(vscode.extensions, "getExtension").withArgs("vscode.git").returns({
      isActive: true,
      exports: {
        getAPI: () => ({repositories: []})
      }
    } as any);
    sandbox.stub(vscode.workspace, "workspaceFolders").value([
      {uri: vscode.Uri.file(workspaceRoot), name: "workspace", index: 0}
    ]);

    try {
      const roots = await new WorkspaceService().getGitRepositoryRoots();
      const normalizeRoots = (values: string[]) => values.map(value => path.normalize(value).toLowerCase()).sort();

      assert.deepStrictEqual(normalizeRoots(roots), normalizeRoots([repoA, repoB]));
    } finally {
      fs.rmSync(workspaceRoot, {recursive: true, force: true});
    }
  });
});
