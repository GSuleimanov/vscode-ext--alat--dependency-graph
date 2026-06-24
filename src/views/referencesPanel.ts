import * as vscode from 'vscode';
import * as path from 'path';
import { filterLocations, isTestLocation, isImportLocation, getConfig } from '../util/javaUtils';
import { classifyLocations, LocationKind } from '../util/locationClassifier';

// ── Public input type ─────────────────────────────────────────────────────────

export interface PanelInput {
  symbolName: string;
  originUri: vscode.Uri;
  originPosition: vscode.Position;
  rawLocations: vscode.Location[];
  typeDefLocations: vscode.Location[];
  defLocations: vscode.Location[];
  implLocations: vscode.Location[];
}

// ── Internal data sent to webview ─────────────────────────────────────────────

interface ItemData {
  uri: string;
  line: number;
  column: number;
  lineText: string;
  relativePath: string;
  filename: string;
  isCurrent: boolean;
}

interface GroupData {
  kind: LocationKind;
  items: ItemData[];
}

interface PanelData {
  symbolName: string;
  filterImports: boolean;
  totalCount: number;
  visibleCount: number;
  counts: { imports: number };
  groups: GroupData[];
}

// ── Panel class ───────────────────────────────────────────────────────────────

const CONFIG: Record<string, string> = {
  filterImports: 'codenav.filterImports',
};

export class ReferencesPanel {
  private static current: ReferencesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private input!: PanelInput;
  private filterImports: boolean;
  private previewDebounce: ReturnType<typeof setTimeout> | undefined;

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.filterImports = getConfig().get<boolean>('filterImports') ?? true;

    panel.webview.html = buildHtml();

    panel.webview.onDidReceiveMessage(async (msg: { command: string; key?: string; uri?: string; line?: number; column?: number }) => {
      switch (msg.command) {
        case 'toggleFilter': await this.handleToggle(msg.key!); break;
        case 'navigate':     await this.handleNavigate(msg.uri!, msg.line!, msg.column!); break;
        case 'preview':      this.handlePreview(msg.uri!, msg.line!); break;
        case 'close':        this.panel.dispose(); break;
      }
    }, undefined, context.subscriptions);

    // Sync when config changes externally (e.g. status bar toggle or settings UI)
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async e => {
        if (!e.affectsConfiguration('codenav')) { return; }
        const i = getConfig().get<boolean>('filterImports') ?? true;
        if (i !== this.filterImports) {
          this.filterImports = i;
          await this.refresh();
        }
      })
    );

    panel.onDidDispose(() => {
      clearTimeout(this.previewDebounce);
      ReferencesPanel.current = undefined;
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  static async show(context: vscode.ExtensionContext, input: PanelInput): Promise<void> {
    if (ReferencesPanel.current) {
      ReferencesPanel.current.panel.reveal(vscode.ViewColumn.Beside, false);
      ReferencesPanel.current.input = input;
      await ReferencesPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codenavReferences',
      `References: ${input.symbolName}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const instance = new ReferencesPanel(panel, context);
    ReferencesPanel.current = instance;
    instance.input = input;
    await instance.refresh();
  }

  // ── Event handlers ──────────────────────────────────────────────────────────

  private async handleToggle(key: string): Promise<void> {
    if (key === 'filterImports') this.filterImports = !this.filterImports;

    await this.refresh();

    // Write to config after refresh so the config-change listener sees no delta
    const cfgKey = CONFIG[key];
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
    }, 200);
  }

  // ── Data building ───────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    const data = await this.buildData();
    this.panel.title = `References: ${this.input.symbolName}`;
    this.panel.webview.postMessage({ command: 'update', data });
  }

  private async buildData(): Promise<PanelData> {
    const { rawLocations, typeDefLocations, defLocations, implLocations, originUri, originPosition, symbolName } = this.input;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    let importCount = 0;
    for (const loc of rawLocations) {
      if (await isImportLocation(loc)) { importCount++; }
    }

    const afterFilters = await filterLocations(rawLocations, false, this.filterImports);
    const testLocs    = afterFilters.filter(l => isTestLocation(l));
    const nonTestLocs = afterFilters.filter(l => !isTestLocation(l));

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

    const ORDER: LocationKind[] = ['typeDefinition', 'definition', 'implementation', 'reference', 'test'];
    const groups: GroupData[] = [];

    for (const kind of ORDER) {
      const locs = kind === 'test'
        ? testLocs
        : classified.filter(c => c.kind === kind).map(c => c.location);
      if (!locs.length) { continue; }
      const items = await Promise.all(locs.map(toItemData));
      groups.push({ kind, items });
    }

    return {
      symbolName,
      filterImports: this.filterImports,
      totalCount: rawLocations.length,
      visibleCount: groups.reduce((s, g) => s + g.items.length, 0),
      counts: { imports: importCount },
      groups,
    };
  }
}

// ── HTML / CSS / JS ───────────────────────────────────────────────────────────

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
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
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.header {
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
.symbol-name {
  font-size: 1.05em; font-weight: 700; margin-bottom: 10px;
  color: var(--vscode-foreground); letter-spacing: 0.01em;
}
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }

.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 9px 2px 7px; border-radius: 100px;
  border: 1px solid transparent; cursor: pointer;
  font-size: 0.78em; font-family: inherit; font-weight: 600;
  user-select: none; outline: none; transition: opacity 0.1s;
}
.chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.chip .x { font-size: 0.8em; margin-left: 1px; opacity: 0.7; }
.chip-imports { background: #569cd628; color: #7ab8f5; border-color: #569cd655; }
.chip.off     { opacity: 0.38; }

.stats { font-size: 0.76em; color: var(--vscode-descriptionForeground); }

.results {
  flex: 1; overflow-y: auto; padding: 4px 0 24px; outline: none;
  scrollbar-width: thin;
  scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
}

.empty { padding: 20px 16px; color: var(--vscode-descriptionForeground); font-style: italic; }

.group-hdr {
  display: flex; align-items: center; gap: 5px;
  padding: 10px 16px 3px;
  font-size: 0.69em; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--vscode-descriptionForeground);
  cursor: pointer; user-select: none;
}
.group-hdr:hover { color: var(--vscode-foreground); }
.toggle { display: inline-block; transition: transform 0.15s; }
.group.collapsed .toggle { transform: rotate(-90deg); }
.group.collapsed .row { display: none; }
.group-sep { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 6px 0 0; }

.row {
  padding: 5px 16px; cursor: pointer;
  display: flex; flex-direction: column; gap: 2px;
}
.row:hover { background: var(--vscode-list-hoverBackground); }

.row-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.row-file { font-weight: 600; font-size: 0.88em; white-space: nowrap; }
.row-path {
  color: var(--vscode-descriptionForeground);
  font-size: 0.78em; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; flex: 1; min-width: 0;
}
.row-code {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.83em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.bdg {
  display: inline-flex; align-items: center;
  padding: 1px 6px; border-radius: 100px;
  font-size: 0.7em; font-weight: 700;
  white-space: nowrap; letter-spacing: 0.02em; border: 1px solid transparent;
}
.bdg-typeDefinition { background: #c586c028; color: #c586c0; border-color: #c586c055; }
.bdg-definition     { background: #569cd628; color: #7ab8f5; border-color: #569cd655; }
.bdg-implementation { background: #b5cea828; color: #b5cea8; border-color: #b5cea855; }
.bdg-current        { background: #e2c08d28; color: #e2c08d; border-color: #e2c08d55; }
</style>
</head>
<body>
<div id="root"><div class="header"><div class="symbol-name">Loading…</div></div></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let _pt, _sel = -1, _rows = [];

const LABELS = { typeDefinition:'Type Definitions', definition:'Definitions',
                 implementation:'Implementations', reference:'References', test:'Tests' };

window.addEventListener('message', ({ data }) => {
  if (data.command !== 'update') { return; }
  document.getElementById('root').innerHTML = buildHtml(data.data);
  refreshRows();
  _sel = -1;
  document.getElementById('results').focus();
});

function buildHtml(d) {
  const hidden = d.totalCount - d.visibleCount;
  const stats = hidden > 0
    ? d.visibleCount + ' of ' + d.totalCount + ' · ' + hidden + ' hidden'
    : d.visibleCount + ' result' + (d.visibleCount === 1 ? '' : 's');

  let out = '<div class="header">'
    + '<div class="symbol-name">' + esc(d.symbolName) + '</div>'
    + '<div class="chips">'
    + mkChip('filterImports', d.filterImports, '{ }', 'Imports', d.counts.imports, 'chip-imports')
    + '</div>'
    + '<div class="stats">' + stats + '</div>'
    + '</div>'
    + '<div class="results" id="results" tabindex="-1">';

  if (!d.groups.length) {
    out += '<div class="empty">No references found.</div>';
  }

  d.groups.forEach((g, gi) => {
    if (gi > 0) { out += '<hr class="group-sep">'; }
    out += '<div class="group" data-kind="' + g.kind + '">'
      + '<div class="group-hdr"><span class="toggle">▼</span>'
      + esc(LABELS[g.kind]) + ' (' + g.items.length + ')</div>';

    g.items.forEach(item => {
      const current = item.isCurrent ? '<span class="bdg bdg-current">current</span>' : '';
      out += '<div class="row"'
        + ' data-uri="' + esc(item.uri) + '"'
        + ' data-line="' + item.line + '"'
        + ' data-col="' + item.column + '">'
        + '<div class="row-top">'
        + '<span class="row-file">' + esc(item.filename) + ':' + (item.line + 1) + '</span>'
        + current
        + '<span class="row-path">' + esc(item.relativePath) + '</span>'
        + '</div>'
        + '<div class="row-code">' + esc(item.lineText) + '</div>'
        + '</div>';
    });

    out += '</div>';
  });

  return out + '</div>';
}

function mkChip(key, active, icon, label, count, cls) {
  return '<button class="chip ' + cls + (active ? '' : ' off') + '" data-key="' + key + '">'
    + '<span>' + icon + '</span>'
    + '<span>' + label + (count ? ' ' + count : '') + '</span>'
    + (active ? '<span class="x">✕</span>' : '')
    + '</button>';
}

function refreshRows() {
  _rows = Array.from(document.querySelectorAll('.row')).filter(r => r.offsetParent !== null);
}

document.addEventListener('click', e => {
  const hdr = e.target.closest('.group-hdr');
  if (hdr) { hdr.closest('.group').classList.toggle('collapsed'); refreshRows(); return; }
  const chip = e.target.closest('[data-key]');
  if (chip) { vscode.postMessage({ command: 'toggleFilter', key: chip.dataset.key }); return; }
  const row = e.target.closest('.row');
  if (row) { navigateTo(row); }
});

document.addEventListener('mouseover', e => {
  const row = e.target.closest('.row');
  if (!row) { return; }
  const idx = _rows.indexOf(row);
  if (idx !== _sel) { select(idx, true); }
});

document.addEventListener('keydown', e => {
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); select(Math.min(_sel + 1, _rows.length - 1), true); break;
    case 'ArrowUp':   e.preventDefault(); select(Math.max(_sel - 1, 0), true); break;
    case 'Enter':     if (_sel >= 0 && _rows[_sel]) { navigateTo(_rows[_sel]); } break;
    case 'Escape':    vscode.postMessage({ command: 'close' }); break;
  }
});

function select(idx, sendPreview) {
  _sel = idx;
  if (idx < 0 || idx >= _rows.length) { return; }
  const row = _rows[idx];
  row.scrollIntoView({ block: 'nearest' });
  if (!sendPreview) { return; }
  clearTimeout(_pt);
  _pt = setTimeout(() => {
    vscode.postMessage({ command: 'preview', uri: row.dataset.uri, line: +row.dataset.line });
  }, 80);
}

function navigateTo(row) {
  clearTimeout(_pt);
  vscode.postMessage({ command: 'navigate',
    uri: row.dataset.uri, line: +row.dataset.line, column: +row.dataset.col });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
}
