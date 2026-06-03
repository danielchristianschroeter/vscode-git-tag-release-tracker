import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

interface ExtensionManifest {
  activationEvents?: string[];
}

suite("Extension Manifest Test Suite", () => {
  function readManifest(): ExtensionManifest {
    const manifestPath = path.resolve(__dirname, "..", "..", "..", "package.json");
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExtensionManifest;
  }

  test("activates when the opened folder contains nested Git repositories", () => {
    const manifest = readManifest();

    assert.ok(
      manifest.activationEvents?.includes("workspaceContains:**/.git/HEAD"),
      "package.json should activate for nested Git repositories so multi-repo container folders show status bar items"
    );
  });

  test("activates after startup so repository containers are initialized", () => {
    const manifest = readManifest();

    assert.ok(
      manifest.activationEvents?.includes("onStartupFinished"),
      "package.json should activate after startup because workspaceContains can miss folders that only contain nested repos"
    );
  });
});
