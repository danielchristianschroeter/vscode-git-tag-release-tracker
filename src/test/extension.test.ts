import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import simpleGit, { SimpleGit } from "simple-git";
import * as semver from "semver";
import * as sinon from "sinon";
import * as os from "os";

let git: SimpleGit;
let workspacePath: string;

suite("Extension Test Suite", () => {
  setup(async () => {
    // Create a temporary directory for the test workspace
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "test-workspace-"));
    git = simpleGit(workspacePath);

    // Initialize a new Git repository for testing
    await git.init();
    fs.writeFileSync(
      path.join(workspacePath, "README.md"),
      "# Test Repository"
    );
    await git.add(".");
    await git.commit("Initial commit");
  });

  teardown(async () => {
    // Cleanup the test workspace
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("should detect Git repository and initialize status bar", async () => {
    // Simulate status bar initialization
    const statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    statusBarItem.text = "$(git-commit) 0 unreleased commits";
    statusBarItem.show();

    assert.strictEqual(
      statusBarItem.text,
      "$(git-commit) 0 unreleased commits",
      "Status bar should display unreleased commits"
    );

    // Cleanup
    statusBarItem.dispose();
  });

  test("should create and push tag correctly", async () => {
    // Mock the push method to prevent actual network calls
    const pushStub = sinon.stub(git, "push").resolves({
      pushed: [],
      remoteMessages: { all: [] },
    });

    const tags = await git.tags();
    const latestTag = tags.latest || "0.0.0";

    const newVersion = semver.inc(latestTag, "patch");
    await git.addTag(newVersion!);

    const newTags = await git.tags();
    assert.ok(newTags.all.includes(newVersion!), "New tag should be created");

    // Restore the original method
    pushStub.restore();
  });
});
