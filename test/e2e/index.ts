import * as path from 'path';
import { runCucumber, loadConfiguration } from '@cucumber/cucumber/api';

// This module is the `extensionTestsPath` entry: VS Code calls run() inside the extension
// host, where `vscode` is available to the step definitions. We drive Cucumber here.
export async function run(): Promise<void> {
  // Compiled layout: out-e2e/test/e2e/index.js → repo root is three levels up.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  // `file: false` ignores the project's cucumber.js (which loads unrelated step
  // definitions); we only want our compiled e2e support here.
  const { runConfiguration } = await loadConfiguration({
    file: false,
    provided: {
      paths: [path.join(repoRoot, 'test', 'e2e', 'features', 'token-behavior.feature')],
      require: [path.join(repoRoot, 'out-e2e', 'test', 'e2e', 'support', '*.js')],
    },
  });

  const { success } = await runCucumber(runConfiguration);
  if (!success) {
    throw new Error('e2e Cucumber scenarios failed');
  }
}
