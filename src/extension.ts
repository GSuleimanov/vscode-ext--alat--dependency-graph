import * as vscode from 'vscode';
import { createPeekFilteredCommand } from './commands/filteredPeek';
import { GraphSideView } from './commands/graphView';
import { ReferencesSideView } from './views/referencesSideView';

export function activate(context: vscode.ExtensionContext): void {
  const referencesView = new ReferencesSideView(context);
  const graphView = new GraphSideView(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReferencesSideView.viewId,
      referencesView,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      GraphSideView.viewId,
      graphView,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand(
      'codenav.findReferences',
      createPeekFilteredCommand(referencesView, (uri) => graphView.focusUri(uri.toString()))
    ),
    vscode.commands.registerCommand('codenav.openGraph', () => graphView.reveal())
  );

  // Reflect Java language server readiness on the references panel's idle screen, so the
  // user can tell when peek is actually available (the server takes a while to start).
  void signalJavaReadiness(referencesView);
}

async function signalJavaReadiness(view: ReferencesSideView): Promise<void> {
  const ext = vscode.extensions.getExtension('redhat.java');
  if (!ext) { return; } // no Java extension — leave idle in its default state

  // Show a native progress bar in the references view's title while the Java
  // language server starts (VSCode's "Views With Progress" — referencing the view
  // id renders the indeterminate bar on that view itself).
  await vscode.window.withProgress(
    { location: { viewId: ReferencesSideView.viewId }, title: 'Java language server starting…' },
    async () => {
      try {
        if (!ext.isActive) { await ext.activate(); }
        const api = ext.exports as { serverReady?: () => Promise<boolean> } | undefined;
        if (api?.serverReady) { await api.serverReady(); }
        view.setJavaReady(true);
      } catch {
        /* leave the idle screen showing "starting" if readiness can't be determined */
      }
    }
  );
}

export function deactivate(): void {}
