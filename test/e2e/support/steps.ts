import * as assert from 'assert';
import * as vscode from 'vscode';
import { Given, When, Then } from '@cucumber/cucumber';
import { PeekWorld } from './world';
import type { PeekOutcome, OutcomeItem } from '../../../src/commands/peekOutcome';

const SRC_ROOT = 'src/main/java/com/gsuleimanov/sample';

function fixtureUri(rel: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { throw new Error('No workspace folder is open'); }
  return vscode.Uri.joinPath(folder.uri, SRC_ROOT, rel);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findToken(doc: vscode.TextDocument, token: string): vscode.Position {
  const re = new RegExp('\\b' + escapeRegExp(token) + '\\b');
  for (let line = 0; line < doc.lineCount; line++) {
    const m = re.exec(doc.lineAt(line).text);
    if (m) { return new vscode.Position(line, m.index); }
  }
  throw new Error(`Token "${token}" not found in ${doc.uri.fsPath}`);
}

function sectionItems(outcome: PeekOutcome | undefined, kind: string): OutcomeItem[] {
  const sections = outcome?.sections as Record<string, OutcomeItem[]> | undefined;
  return sections?.[kind] ?? [];
}

/** Wait until the language server can resolve symbols in the file (project import done). */
async function waitForLsp(uri: vscode.Uri): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const symbols = await Promise.resolve(
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri)
    ).then(r => r ?? []).catch(() => []);
    if (symbols.length > 0) { return; }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for the Java language server to import the project');
}

Given('the sample project is open and the Java language server is ready', { timeout: 300000 }, async function () {
  const ext = vscode.extensions.getExtension('redhat.java');
  assert.ok(ext, 'redhat.java (Language Support for Java) must be installed for e2e tests');
  if (!ext!.isActive) { await ext!.activate(); }
  const api = ext!.exports as { serverReady?: () => Promise<boolean> } | undefined;
  if (api?.serverReady) { await api.serverReady(); }
  await waitForLsp(fixtureUri('repo/ProfileRepository.java'));
});

When(
  'I peek references on {string} in {string}',
  { timeout: 120000 },
  async function (this: PeekWorld, token: string, rel: string) {
    const uri = fixtureUri(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = findToken(doc, token);
    editor.selection = new vscode.Selection(pos, pos);
    this.outcome = await vscode.commands.executeCommand<PeekOutcome>('codenav.findReferences');
  }
);

Then('the peek succeeds', function (this: PeekWorld) {
  assert.equal(
    this.outcome?.status, 'results',
    `expected results, got "${this.outcome?.status}": ${this.outcome?.message ?? ''}`
  );
});

Then('the peek is refused', function (this: PeekWorld) {
  assert.equal(this.outcome?.status, 'refused', `expected refused, got "${this.outcome?.status}"`);
});

Then('the {string} section includes {string}', function (this: PeekWorld, kind: string, fragment: string) {
  const items = sectionItems(this.outcome, kind);
  assert.ok(
    items.some(i => i.path.includes(fragment)),
    `expected "${kind}" to include "${fragment}"; got: ${items.map(i => i.path).join(', ') || '(none)'}`
  );
});

Then('the {string} section does not include {string}', function (this: PeekWorld, kind: string, fragment: string) {
  const items = sectionItems(this.outcome, kind);
  assert.ok(
    !items.some(i => i.path.includes(fragment)),
    `expected "${kind}" to NOT include "${fragment}"; got: ${items.map(i => i.path).join(', ')}`
  );
});
