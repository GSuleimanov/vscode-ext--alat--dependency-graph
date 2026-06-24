import * as vscode from 'vscode';
import { getConfig } from './util/javaUtils';

export class FilterStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codenav.toggleTestFilter';

    context.subscriptions.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('codenav.filterTests')) {
          this.update();
        }
      })
    );

    this.update();
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'java') {
      this.item.hide();
      return;
    }

    const filtering = getConfig().get<boolean>('filterTests') ?? true;

    if (filtering) {
      this.item.text = '$(filter) Tests';
      this.item.tooltip = 'Test references are hidden — click to include them';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = '$(eye) Tests';
      this.item.tooltip = 'Test references are visible — click to hide them';
      this.item.backgroundColor = undefined;
    }

    this.item.show();
  }
}
