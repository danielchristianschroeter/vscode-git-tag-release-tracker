import path from "path";
import Mocha from "mocha";
import {glob} from "glob";

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 30000
  });

  const testsRoot = path.resolve(__dirname, "..");

  try {
    const files = await glob("**/**.test.js", {cwd: testsRoot});

    // Add files to the test suite
    files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

    // Run the mocha test
    return new Promise<void>((resolve, reject) => {
      mocha.run(failures => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    });
  } catch (err) {
    console.error("Error loading test files:", err);
    throw err;
  }
}
