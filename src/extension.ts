import * as vscode from 'vscode';
import { GraphSideView } from './commands/graphView';
import { initProviders } from './graph/lang';
import { initProjectIndex } from './graph/data/indexService';

export function activate(context: vscode.ExtensionContext): void {
  const graphView = new GraphSideView(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('alat.openDependencyGraph', () => graphView.reveal())
  );

  void signalLanguageReadiness(graphView);

  // Kick the project index (tree-sitter reverse index — the graph's data source
  // for callers/deps/siblings). Chunked background build; the graph awaits
  // readiness instead of polling any language server.
  void initProjectIndex(context, {
    onProgress: (indexed, total) => graphView.postIndexProgress(indexed, total),
    onStats: (stats) => graphView.postIndexStats(stats),
  });
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
