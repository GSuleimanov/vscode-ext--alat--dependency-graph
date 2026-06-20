import * as vscode from 'vscode';
import * as path from 'path';
import { filterLocations, isTestLocation, isImportLocation, getConfig } from '../util/javaUtils';
import { classifyLocations, LocationKind } from '../util/locationClassifier';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface PanelInput {
  symbolName: string;
  originUri: vscode.Uri;
  originPosition: vscode.Position;
  rawLocations: vscode.Location[];
  typeDefLocations: vscode.Location[];
  defLocations: vscode.Location[];
  implLocations: vscode.Location[];
}

interface ItemData {
  uri: string;
  line: number;
  column: number;
  lineText: string;
  relativePath: string;
  filename: string;
  isCurrent: boolean;
}

interface FileGroupData { filename: string; relativePath: string; items: ItemData[]; }
interface GroupData { kind: LocationKind; files: FileGroupData[]; totalItems: number; }

interface ViewData {
  symbolName: string;
  filterImports: boolean;
  totalCount: number;
  visibleCount: number;
  counts: { imports: number };
  groups: GroupData[];
}

// ── Provider ──────────────────────────────────────────────────────────────────

const CONFIG_KEYS: Record<string, string> = {
  filterImports: 'javaNavigator.filterImports',
};

export class ReferencesSideView implements vscode.WebviewViewProvider {
  static readonly viewId = 'javaNavigator.referencesView';

  private view?: vscode.WebviewView;
  private input?: PanelInput;
  private filterImports: boolean;
  private previewDebounce?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.filterImports = getConfig().get<boolean>('filterImports') ?? true;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveCtx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = buildHtml();

    webviewView.webview.onDidReceiveMessage(
      async (msg: { command: string; key?: string; uri?: string; line?: number; column?: number }) => {
        switch (msg.command) {
          case 'toggleFilter': await this.handleToggle(msg.key!); break;
          case 'navigate':     await this.handleNavigate(msg.uri!, msg.line!, msg.column!); break;
          case 'preview':      this.handlePreview(msg.uri!, msg.line!); break;
          case 'close':
            vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.input) { this.refresh(); }
    });

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async e => {
        if (!e.affectsConfiguration('javaNavigator')) { return; }
        const i = getConfig().get<boolean>('filterImports') ?? true;
        if (i !== this.filterImports) {
          this.filterImports = i;
          if (this.input) { await this.refresh(); }
        }
      })
    );

    if (this.input) { this.refresh(); }
  }

  async show(input: PanelInput): Promise<void> {
    this.input = input;
    await vscode.commands.executeCommand(`${ReferencesSideView.viewId}.focus`);
    await this.refresh();
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  private async handleToggle(key: string): Promise<void> {
    if (key === 'filterImports') { this.filterImports = !this.filterImports; }
    await this.refresh();
    const cfgKey = CONFIG_KEYS[key];
    if (cfgKey) {
      vscode.workspace.getConfiguration().update(cfgKey, this.filterImports, vscode.ConfigurationTarget.Workspace);
    }
  }

  private async handleNavigate(uri: string, line: number, column: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, column, line, column),
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch { /* ignore */ }
  }

  private handlePreview(uri: string, line: number): void {
    clearTimeout(this.previewDebounce);
    this.previewDebounce = setTimeout(async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(line, 0, line, 0),
          preserveFocus: true,
          preview: true,
          viewColumn: vscode.ViewColumn.One,
        });
      } catch { /* ignore */ }
    }, 80);
  }

  // ── Data ──────────────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    if (!this.view || !this.input) { return; }
    const data = await this.buildData();
    this.view.webview.postMessage({ command: 'update', data });
  }

  private async buildData(): Promise<ViewData> {
    const input = this.input!;
    const seenKeys = new Set<string>();
    const dedupedRaw = input.rawLocations.filter(l => {
      const k = `${l.uri.fsPath}:${l.range.start.line}`;
      return seenKeys.has(k) ? false : (seenKeys.add(k), true);
    });
    const { typeDefLocations, defLocations, implLocations, originUri, originPosition, symbolName } = input;
    const rawLocations = dedupedRaw;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    let importCount = 0;
    for (const loc of rawLocations) {
      if (await isImportLocation(loc)) { importCount++; }
    }

    const afterFilters = await filterLocations(rawLocations, false, this.filterImports);
    const testLocs    = afterFilters.filter(l => isTestLocation(l));
    const nonTestLocs = afterFilters.filter(l => !isTestLocation(l));

    // Include typeDefLocations not already present in the non-test set
    const locKey = (l: vscode.Location) => `${l.uri.fsPath}:${l.range.start.line}`;
    const nonTestKeys = new Set(nonTestLocs.map(locKey));
    const extraTypeDefs = typeDefLocations.filter(l => !nonTestKeys.has(locKey(l)));

    const classified = classifyLocations(
      [...nonTestLocs, ...extraTypeDefs],
      typeDefLocations, defLocations, implLocations
    );

    const toItemData = async (loc: vscode.Location): Promise<ItemData> => {
      let lineText = '';
      try {
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        lineText = doc.lineAt(loc.range.start.line).text.trim();
      } catch { /* ignore */ }
      return {
        uri: loc.uri.toString(),
        line: loc.range.start.line,
        column: loc.range.start.character,
        lineText,
        relativePath: path.relative(wsRoot, loc.uri.fsPath),
        filename: path.basename(loc.uri.fsPath),
        isCurrent: loc.uri.fsPath === originUri.fsPath && loc.range.start.line === originPosition.line,
      };
    };

    const toFileGroups = (items: ItemData[]): FileGroupData[] => {
      const fileMap = new Map<string, FileGroupData>();
      for (const item of items) {
        if (!fileMap.has(item.uri)) {
          fileMap.set(item.uri, { filename: item.filename, relativePath: item.relativePath, items: [] });
        }
        fileMap.get(item.uri)!.items.push(item);
      }
      return Array.from(fileMap.values());
    };

    const ORDER: LocationKind[] = ['typeDefinition', 'definition', 'implementation', 'reference', 'test'];
    const groups: GroupData[] = [];

    for (const kind of ORDER) {
      const locs = kind === 'test'
        ? testLocs
        : classified.filter(c => c.kind === kind).map(c => c.location);
      if (!locs.length) { continue; }
      const items = await Promise.all(locs.map(toItemData));
      groups.push({ kind, files: toFileGroups(items), totalItems: items.length });
    }

    return {
      symbolName,
      filterImports: this.filterImports,
      totalCount: rawLocations.length,
      visibleCount: groups.reduce((s, g) => s + g.totalItems, 0),
      counts: { imports: importCount },
      groups,
    };
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function nonce(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function buildHtml(): string {
  const n = nonce();
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}

.header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--vscode-editor-background);
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.symbol-name { font-size: 1.05em; font-weight: 700; margin-bottom: 8px; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px 2px 7px; border-radius: 100px;
  border: 1px solid transparent; cursor: pointer;
  font-size: 0.78em; font-family: inherit; font-weight: 600;
  user-select: none; outline: none;
}
.chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.chip .x { font-size: 0.8em; margin-left: 1px; opacity: 0.7; }
.chip-imports { background: #569cd628; color: #7ab8f5; border-color: #569cd655; }
.chip.off { opacity: 0.38; }
.stats { font-size: 0.74em; color: var(--vscode-descriptionForeground); }

.results { padding: 4px 0 16px; }

.idle {
  padding: 20px 14px; color: var(--vscode-descriptionForeground);
  font-style: italic; font-size: 0.9em;
}
.idle kbd {
  font-style: normal; font-size: 0.85em;
  background: var(--vscode-keybindingLabel-background);
  border: 1px solid var(--vscode-keybindingLabel-border);
  border-radius: 3px; padding: 1px 5px;
}
.empty { padding: 14px; color: var(--vscode-descriptionForeground); font-style: italic; }

.group-sep { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 5px 0 0; }

.group-hdr {
  display: flex; align-items: center; gap: 5px;
  padding: 8px 14px 3px;
  font-size: 0.69em; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--vscode-descriptionForeground);
  cursor: pointer; user-select: none;
}
.group-hdr:hover { color: var(--vscode-foreground); }
.toggle { display: inline-block; transition: transform 0.15s; font-style: normal; }
.group.collapsed .toggle { transform: rotate(-90deg); }
.group.collapsed .file-hdr,
.group.collapsed .row { display: none; }

.file-hdr {
  display: flex; align-items: baseline; gap: 6px;
  padding: 5px 14px 2px;
}
.file-hdr-name { font-size: 0.88em; font-weight: 700; }
.file-hdr-count { font-size: 0.75em; color: var(--vscode-descriptionForeground); }

.row {
  padding: 3px 14px 3px 26px;
  cursor: pointer;
  display: flex; flex-direction: row; align-items: baseline; gap: 8px;
  overflow: hidden;
}
.row.solo { padding-left: 14px; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

.row-loc {
  font-size: 0.84em; font-weight: 700;
  color: var(--vscode-foreground);
  white-space: nowrap; flex-shrink: 0;
}
.row-code {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0;
}

.bdg {
  display: inline-flex; align-items: center;
  padding: 1px 5px; border-radius: 100px;
  font-size: 0.7em; font-weight: 700;
  white-space: nowrap; border: 1px solid transparent;
}
.bdg-current { background: #e2c08d28; color: #e2c08d; border-color: #e2c08d55; }
</style>
</head>
<body>
<div id="root">
  <div class="header"><div class="symbol-name">Java References</div></div>
  <div class="results">
    <div class="idle">Place cursor on a Java symbol and press <kbd>Shift+Alt+F12</kbd></div>
  </div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let _pt, _sel = -1, _rows = [];

const LABELS = {
  typeDefinition: 'Type Definitions', definition: 'Definitions',
  implementation: 'Implementations', reference: 'References', test: 'Tests'
};

window.addEventListener('message', ({ data }) => {
  if (data.command !== 'update') { return; }
  document.getElementById('root').innerHTML = buildHtml(data.data);
  refreshRows();
  _sel = -1;
});

function buildHtml(d) {
  const hidden = d.totalCount - d.visibleCount;
  const stats = hidden > 0
    ? d.visibleCount + ' of ' + d.totalCount + ' · ' + hidden + ' hidden'
    : d.visibleCount + ' result' + (d.visibleCount === 1 ? '' : 's');

  let out = '<div class="header">'
    + '<div class="symbol-name">' + esc(d.symbolName) + '</div>'
    + '<div class="chips">'
    + chip('filterImports', d.filterImports, '{ }', 'Imports', d.counts.imports, 'chip-imports')
    + '</div><div class="stats">' + stats + '</div></div>'
    + '<div class="results" id="results" tabindex="-1">';

  if (!d.groups.length) {
    out += '<div class="empty">No references found.</div>';
  }

  d.groups.forEach((g, gi) => {
    if (gi > 0) { out += '<hr class="group-sep">'; }
    out += '<div class="group" data-kind="' + g.kind + '">'
      + '<div class="group-hdr"><span class="toggle">▼</span>'
      + esc(LABELS[g.kind]) + ' (' + g.totalItems + ')</div>';

    g.files.forEach(file => {
      const multi = file.items.length > 1;
      if (multi) {
        out += '<div class="file-hdr">'
          + '<span class="file-hdr-name">' + esc(file.filename) + '</span>'
          + '<span class="file-hdr-count">' + file.items.length + ' occurrences</span>'
          + '</div>';
      }
      file.items.forEach(item => {
        const soloCls = multi ? '' : ' solo';
        const locLabel = multi
          ? '<span class="row-loc">:' + (item.line + 1) + '</span>'
          : '<span class="row-loc">' + esc(item.filename) + ':' + (item.line + 1) + '</span>';
        const current = item.isCurrent ? '<span class="bdg bdg-current">current</span>' : '';
        out += '<div class="row' + soloCls + '"'
          + ' data-uri="' + esc(item.uri) + '"'
          + ' data-line="' + item.line + '"'
          + ' data-col="' + item.column + '">'
          + locLabel + current
          + '<span class="row-code">' + esc(item.lineText) + '</span>'
          + '</div>';
      });
    });

    out += '</div>';
  });

  return out + '</div>';
}

function chip(key, active, icon, label, count, cls) {
  return '<button class="chip ' + cls + (active ? '' : ' off') + '" data-key="' + key + '">'
    + icon + ' ' + label + (count ? ' ' + count : '')
    + (active ? ' <span class="x">✕</span>' : '') + '</button>';
}

function refreshRows() {
  _rows = Array.from(document.querySelectorAll('.row')).filter(r => r.offsetParent !== null);
}

document.addEventListener('click', e => {
  const hdr = e.target.closest('.group-hdr');
  if (hdr) {
    hdr.closest('.group').classList.toggle('collapsed');
    refreshRows();
    return;
  }
  const c = e.target.closest('[data-key]');
  if (c) { vscode.postMessage({ command: 'toggleFilter', key: c.dataset.key }); return; }
  const r = e.target.closest('.row');
  if (r) { navigateTo(r); }
});

document.addEventListener('mouseover', e => {
  const r = e.target.closest('.row');
  if (!r) { return; }
  const i = _rows.indexOf(r);
  if (i !== _sel) { select(i, false); }
});

document.addEventListener('keydown', e => {
  if      (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(_sel + 1, _rows.length - 1), true); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); select(Math.max(_sel - 1, 0), true); }
  else if (e.key === 'Enter' && _sel >= 0) { navigateTo(_rows[_sel]); }
  else if (e.key === 'Escape') { vscode.postMessage({ command: 'close' }); }
});

function select(idx, preview) {
  _rows.forEach(r => r.classList.remove('selected'));
  _sel = idx;
  if (idx < 0 || idx >= _rows.length) { return; }
  const row = _rows[idx];
  row.classList.add('selected');
  row.scrollIntoView({ block: 'nearest' });
  if (!preview) { return; }
  clearTimeout(_pt);
  _pt = setTimeout(() => vscode.postMessage({ command: 'preview', uri: row.dataset.uri, line: +row.dataset.line }), 80);
}

function navigateTo(row) {
  clearTimeout(_pt);
  vscode.postMessage({ command: 'navigate', uri: row.dataset.uri, line: +row.dataset.line, column: +row.dataset.col });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
}
