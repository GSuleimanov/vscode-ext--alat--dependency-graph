import * as vscode from 'vscode';
import { GraphSideView } from './commands/graphView';

export function activate(context: vscode.ExtensionContext): void {
  const graphView = new GraphSideView(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('codenav.openGraph', () => graphView.reveal())
  );

  void signalJavaReadiness(graphView);
}

async function signalJavaReadiness(graphView: GraphSideView): Promise<void> {
  const ext = vscode.extensions.getExtension('redhat.java');
  if (!ext) {
    graphView.setJavaReady(true);
    return;
  }
  try {
    if (!ext.isActive) { await ext.activate(); }
    const api = ext.exports as { serverReady?: () => Promise<boolean> } | undefined;
    if (api?.serverReady) { await api.serverReady(); }
    graphView.setJavaReady(true);
  } catch {
    /* leave graph showing "starting" if readiness can't be determined */
  }
}

export function deactivate(): void {}
