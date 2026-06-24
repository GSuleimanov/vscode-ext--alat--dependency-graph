import * as path from 'path';
import * as cp from 'child_process';
import {
  runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';

// Launches a real VS Code with the Java extension against the sample project, then runs
// the Cucumber scenarios inside it. Requires a JDK on the machine (redhat.java needs it).
async function main(): Promise<void> {
  // Compiled layout: out-e2e/test/e2e/runTest.js → repo root is three levels up.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const extensionDevelopmentPath = repoRoot;
  const extensionTestsPath = path.resolve(__dirname, 'index.js');
  const samplePath = path.resolve(repoRoot, 'test-fixtures', 'gomatch-sample');

  try {
    const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');

    // Install the Java extension into the test VS Code instance.
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    cp.spawnSync(cli, [...cliArgs, '--install-extension', 'redhat.java'], {
      encoding: 'utf-8',
      stdio: 'inherit',
    });

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [samplePath, '--disable-workspace-trust'],
    });
  } catch (err) {
    console.error('Failed to run e2e tests:', err);
    process.exit(1);
  }
}

void main();
