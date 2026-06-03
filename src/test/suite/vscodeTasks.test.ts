import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {parse} from "jsonc-parser";

interface TaskConfiguration {
  tasks?: Array<{
    label?: string;
    problemMatcher?: string | unknown[] | Record<string, unknown>;
  }>;
}

suite("VS Code Tasks Test Suite", () => {
  const builtInProblemMatchers = new Set(["$tsc-watch"]);

  function readTasks(): TaskConfiguration {
    const tasksPath = path.resolve(__dirname, "..", "..", "..", ".vscode", "tasks.json");
    return parse(fs.readFileSync(tasksPath, "utf8")) as TaskConfiguration;
  }

  test("does not reference undefined problem matchers", () => {
    const config = readTasks();
    const undefinedProblemMatchers = (config.tasks ?? [])
      .map(task => ({label: task.label, problemMatcher: task.problemMatcher}))
      .filter(({problemMatcher}) => typeof problemMatcher === "string")
      .filter(({problemMatcher}) => !builtInProblemMatchers.has(problemMatcher as string));

    assert.deepStrictEqual(
      undefinedProblemMatchers,
      [],
      "tasks.json should use inline matchers for custom problem matchers instead of undefined $... references"
    );
  });
});
