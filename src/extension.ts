import * as vscode from 'vscode';
import { GraphSideView } from './commands/graphView';
import { initProviders } from './graph/lang';

export function activate(context: vscode.ExtensionContext): void {
  const graphView = new GraphSideView(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('alat.openDependencyGraph', () => graphView.reveal())
  );

  void signalLanguageReadiness(graphView);
}

/**
 * Readiness is provider-driven: once every registered language provider's tree-sitter
 * grammar is loaded, the graph can parse any supported file. Callers/siblings come from
 * whatever language server VSCode has for that file (resolved per-query, not hardcoded
 * to any one extension), so no single LSP is gated on here.
 */
async function signalLanguageReadiness(graphView: GraphSideView): Promise<void> {
  try {
    await initProviders();
  } catch {
    /* grammars may still load lazily on first parse */
  }
  graphView.setLanguageReady(true);
}

export function deactivate(): void {}
