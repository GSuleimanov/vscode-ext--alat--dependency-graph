import * as vscode from 'vscode';
import * as path from 'path';
import { isTestLocation, isImportLocation, getConfig } from '../util/javaUtils';
import { classifyLocations, LocationKind } from '../util/locationClassifier';
import { ProgressUpdate } from '../commands/expandViaType';
import { PeekOutcome } from '../commands/peekOutcome';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface PanelInput {
  symbolName: string;
  originUri: vscode.Uri;
  originPosition: vscode.Position;
  rawLocations: vscode.Location[];
  typeDefLocations: vscode.Location[];
  defLocations: vscode.Location[];
  implLocations: vscode.Location[];
  interfaceLocations?: vscode.Location[];
}

/**
 * Sink the whole-project (phase 2) computation writes to. The peek shows current-class
 * results immediately, then loads the rest of the project through this sink — either
 * automatically (Current class chip off) or on demand when the chip is toggled off.
 * `show` is called with the *full* (current class + whole project) result set.
 */
export interface PeekSink {
  reportProgress(p: ProgressUpdate): void;
  /** Stop the computation early — superseded by a newer peek, or the chip was re-enabled. */
  isAborted(): boolean;
  show(input: PanelInput): Promise<void>;
  fail(text: string): void;
}

/** Runs the whole-project (phase 2) computation, writing to the given sink. */
export type ProjectLoader = (sink: PeekSink) => Promise<PeekOutcome>;

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
  includeImports: boolean;
  includeTests: boolean;
  hideDefinitions: boolean;
  currentClassOnly: boolean;
  totalCount: number;
  visibleCount: number;
  counts: { imports: number; tests: number; definitions: number; currentClass: number };
  groups: GroupData[];
}

// ── Provider ──────────────────────────────────────────────────────────────────

/** Identity of a peeked element — uri + position + symbol — for result caching. */
function inputKey(uriStr: string, line: number, character: number, symbolName: string): string {
  return [uriStr, line, character, symbolName].join('\u0000');
}

export class ReferencesSideView implements vscode.WebviewViewProvider {
  static readonly viewId = 'codenav.referencesView';

  private view?: vscode.WebviewView;
  private input?: PanelInput;
  private filterImports: boolean;
  private includeTests: boolean;
  private hideDefinitions: boolean;
  private currentClassOnly: boolean;
  private previewDebounce?: ReturnType<typeof setTimeout>;
  /** Monotonic id of the latest peek request; older in-flight requests are ignored. */
  private requestSeq = 0;
  private loadingSymbol = '';
  /** Identity of the element the current results were computed for, and whether an
   *  edit has since invalidated them. Used to skip recompute on a repeat peek. */
  private inputKeyStr?: string;
  private resultsStale = false;
  /** Whether the Java language server is ready (peek will work). Drives the idle screen. */
  private javaReady = false;
  /** True once `input` holds the whole-project results (not just the current class). */
  private fullLoaded = false;
  /** Runs the on-demand whole-project search for the current peek, and the request id it
   *  belongs to (so a stale loader from a superseded peek is never invoked). */
  private projectLoader?: ProjectLoader;
  private projectLoaderReqId = -1;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.filterImports = getConfig().get<boolean>('filterImports') ?? true;
    this.includeTests = getConfig().get<boolean>('includeTests') ?? false;
    this.hideDefinitions = getConfig().get<boolean>('hideDefinitions') ?? false;
    this.currentClassOnly = getConfig().get<boolean>('currentClassOnly') ?? false;
    // Any edit may change references anywhere, so invalidate the cached result.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(() => { this.resultsStale = true; })
    );
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
          case 'gotoCurrent':  await this.handleGotoCurrent(); break;
          case 'focusEditor':  vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); break;
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
        if (!e.affectsConfiguration('codenav')) { return; }
        const imp = getConfig().get<boolean>('filterImports') ?? true;
        const tst = getConfig().get<boolean>('includeTests') ?? false;
        const hideDef = getConfig().get<boolean>('hideDefinitions') ?? false;
        const ccOnly = getConfig().get<boolean>('currentClassOnly') ?? false;
        let changed = false;
        if (imp !== this.filterImports) { this.filterImports = imp; changed = true; }
        if (tst !== this.includeTests) { this.includeTests = tst; changed = true; }
        if (hideDef !== this.hideDefinitions) { this.hideDefinitions = hideDef; changed = true; }
        // Only a display change here (current-class is a filter over already-loaded
        // results); if the whole project isn't loaded yet, the chip in the panel is the
        // way to trigger that, so we don't kick off a search from a settings change.
        if (ccOnly !== this.currentClassOnly) { this.currentClassOnly = ccOnly; changed = true; }
        if (changed && this.input) { await this.refresh(); }
      })
    );

    if (this.input) { this.refresh(); }
    else { this.view.webview.postMessage({ command: 'ready', ready: this.javaReady }); }
  }

  /** Whether the Current class chip is on (results limited to the peeked file). Read by
   *  the peek command to decide whether to defer the whole-project search. */
  get currentClassMode(): boolean { return this.currentClassOnly; }

  /** Registers the on-demand whole-project loader produced by the current peek. */
  setProjectLoader(id: number, loader: ProjectLoader): void {
    this.projectLoaderReqId = id;
    this.projectLoader = loader;
  }

  /** Updates the idle screen to reflect whether the Java language server is ready. */
  setJavaReady(ready: boolean): void {
    this.javaReady = ready;
    if (this.view && !this.input) {
      this.view.webview.postMessage({ command: 'ready', ready });
    }
  }

  /**
   * Marks the start of a new peek request and shows the loading screen immediately.
   * Returns the request id; pass it to `show`/`reportProgress` so stale (superseded)
   * requests that finish late are ignored instead of overwriting fresher results.
   */
  async beginLoading(symbolName: string): Promise<number> {
    const id = ++this.requestSeq;
    this.loadingSymbol = symbolName;
    await vscode.commands.executeCommand(`${ReferencesSideView.viewId}.focus`);
    if (id === this.requestSeq) {
      this.view?.webview.postMessage({
        command: 'loading', symbolName, label: 'Searching references…',
      });
    }
    return id;
  }

  reportProgress(id: number, p: { label: string; done?: number; total?: number }): void {
    if (id !== this.requestSeq) { return; }
    this.view?.webview.postMessage({ command: 'loading', symbolName: this.loadingSymbol, ...p });
  }

  /** True while `id` is still the most recent request (not superseded or cancelled). */
  isCurrent(id: number): boolean {
    return id === this.requestSeq;
  }

  /** Renders a terminal message (error / no results / cancelled) for the request, if current. */
  fail(id: number, text: string): void {
    if (id !== this.requestSeq) { return; }
    this.view?.webview.postMessage({ command: 'message', text });
  }

  async show(input: PanelInput, id?: number, full = true): Promise<void> {
    if (id !== undefined && id !== this.requestSeq) { return; } // superseded
    this.input = input;
    this.fullLoaded = full;
    this.inputKeyStr = inputKey(
      input.originUri.toString(), input.originPosition.line, input.originPosition.character, input.symbolName
    );
    this.resultsStale = false;
    await vscode.commands.executeCommand(`${ReferencesSideView.viewId}.focus`);
    if (id !== undefined && id !== this.requestSeq) { return; } // superseded during focus
    await this.refresh();
  }

  /**
   * Loads the whole-project results for the current peek *below* the already-shown
   * current-class results, with an inline progress bar (the current-class rows stay
   * visible the whole time). Once loaded the result is cached on `input`, so a later
   * chip toggle just shows/hides it without searching again.
   */
  async loadProject(id: number): Promise<PeekOutcome> {
    const sym = this.input?.symbolName ?? '';
    // Already have the whole project (cached) — just reveal it.
    if (this.fullLoaded) { await this.refresh(); return { status: 'results', symbolName: sym }; }
    const loader = this.projectLoaderReqId === id ? this.projectLoader : undefined;
    if (!loader) { await this.refresh(); return { status: 'results', symbolName: sym }; }

    this.view?.webview.postMessage({ command: 'expandStart' });
    const sink: PeekSink = {
      reportProgress: (p) => {
        if (this.isCurrent(id)) { this.view?.webview.postMessage({ command: 'expandProgress', ...p }); }
      },
      // Stop if a newer peek superseded this one, or the user re-enabled the chip.
      isAborted: () => !this.isCurrent(id) || this.currentClassOnly,
      show: async (input) => {
        if (!this.isCurrent(id)) { return; }
        this.input = input;
        this.fullLoaded = true;
        await this.refresh(); // re-renders the full set (clears the inline progress)
      },
      fail: () => { /* keep the current-class results; the footer is cleared below */ },
    };
    try {
      return await loader(sink);
    } finally {
      this.view?.webview.postMessage({ command: 'expandEnd' });
    }
  }

  /**
   * If results are already computed for this exact element and haven't been
   * invalidated by an edit, re-display them (no recompute) and return true.
   */
  async reshow(uriStr: string, line: number, character: number, symbolName: string): Promise<boolean> {
    if (!this.input || this.resultsStale) { return false; }
    if (this.inputKeyStr !== inputKey(uriStr, line, character, symbolName)) { return false; }
    this.requestSeq++; // invalidate any in-flight request so it can't overwrite us
    await vscode.commands.executeCommand(`${ReferencesSideView.viewId}.focus`);
    await this.refresh();
    return true;
  }

  /**
   * If the same symbol was peeked again at a *different* occurrence that is already
   * present in the current results, just move the "current" marker to that occurrence
   * (re-floating it to the top) instead of recomputing the whole result set. Returns
   * true when handled.
   */
  async moveCurrentTo(uriStr: string, line: number, character: number, symbolName: string): Promise<boolean> {
    if (!this.input || this.resultsStale) { return false; }
    if (this.input.symbolName !== symbolName) { return false; }
    // The new occurrence must already be among the computed locations — otherwise it
    // may be a different symbol that happens to share this name, and we must recompute.
    const onLine = (l: vscode.Location) => l.uri.toString() === uriStr && l.range.start.line === line;
    const present = [
      ...this.input.rawLocations, ...this.input.typeDefLocations, ...this.input.defLocations,
      ...this.input.implLocations, ...(this.input.interfaceLocations ?? []),
    ].some(onLine);
    if (!present) { return false; }

    this.input.originUri = vscode.Uri.parse(uriStr);
    this.input.originPosition = new vscode.Position(line, character);
    this.inputKeyStr = inputKey(uriStr, line, character, symbolName);
    this.requestSeq++; // invalidate any in-flight request so it can't overwrite us
    await vscode.commands.executeCommand(`${ReferencesSideView.viewId}.focus`);
    await this.refresh();
    return true;
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  private async handleToggle(key: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration();
    if (key === 'imports') {
      this.filterImports = !this.filterImports;
      await this.refresh();
      cfg.update('codenav.filterImports', this.filterImports, vscode.ConfigurationTarget.Workspace);
    } else if (key === 'tests') {
      this.includeTests = !this.includeTests;
      await this.refresh();
      cfg.update('codenav.includeTests', this.includeTests, vscode.ConfigurationTarget.Workspace);
    } else if (key === 'definitions') {
      this.hideDefinitions = !this.hideDefinitions;
      await this.refresh();
      cfg.update('codenav.hideDefinitions', this.hideDefinitions, vscode.ConfigurationTarget.Workspace);
    } else if (key === 'currentClass') {
      this.currentClassOnly = !this.currentClassOnly;
      cfg.update('codenav.currentClassOnly', this.currentClassOnly, vscode.ConfigurationTarget.Workspace);
      if (this.currentClassOnly || this.fullLoaded) {
        // Narrowing back to the current class, or the whole project is already cached —
        // either way this is a pure display change, no searching.
        await this.refresh();
      } else {
        // Expanding to the whole project for the first time: load it below the results.
        await this.loadProject(this.requestSeq);
      }
    }
  }

  private async handleNavigate(uri: string, line: number, column: number): Promise<void> {
    // Cancel any pending preview: it opens with preserveFocus:true and, if it fires after
    // this navigate, would steal focus back from the editor (forcing a second Enter).
    clearTimeout(this.previewDebounce);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, column, line, column),
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
      // When the row was previewed first (or we navigate to the origin), the document is
      // already the active editor, so showTextDocument short-circuits and does NOT move
      // focus out of the webview — the first Enter then appears to do nothing. Force
      // focus into the editor. We always open in ViewColumn.One, so focus that group
      // explicitly rather than the "active" group: right after a fresh peek (which just
      // focused the webview panel) the active group is ambiguous/lagging, which is why a
      // fresh peek needed two Enters while a re-focused pane needed one.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    } catch { /* ignore */ }
  }

  private async handleGotoCurrent(): Promise<void> {
    if (!this.input) { return; }
    const { originUri, originPosition } = this.input;
    await this.handleNavigate(originUri.toString(), originPosition.line, originPosition.character);
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
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const includeImports = !this.filterImports;

    // "Current class" is a display filter over whatever is loaded: keep only locations
    // in the peeked file. The reference count in the current class is reported for the
    // chip regardless of whether the filter is active.
    const originUriStr = input.originUri.toString();
    const inCurrentClass = (l: vscode.Location) => l.uri.toString() === originUriStr;
    const cc = <T extends vscode.Location>(arr: T[]): T[] =>
      this.currentClassOnly ? arr.filter(inCurrentClass) : arr;

    const seenKeys = new Set<string>();
    const dedupedRaw = input.rawLocations.filter(l => {
      const k = `${l.uri.fsPath}:${l.range.start.line}`;
      return seenKeys.has(k) ? false : (seenKeys.add(k), true);
    });
    const currentClassCount = dedupedRaw.filter(inCurrentClass).length;
    const rawLocations = cc(dedupedRaw);
    const typeDefLocations = cc(input.typeDefLocations);
    const defLocations = cc(input.defLocations);
    const implLocations = cc(input.implLocations);
    const interfaceLocations = cc(input.interfaceLocations ?? []);
    const { originUri, originPosition, symbolName } = input;

    // Classify each raw location as import / test once, build the visible set.
    const importFlags = await Promise.all(rawLocations.map(l => isImportLocation(l)));
    let importCount = 0;
    let testCount = 0;
    const visible: vscode.Location[] = [];
    rawLocations.forEach((loc, i) => {
      const isImport = importFlags[i];
      const isTest = isTestLocation(loc);
      if (isImport) { importCount++; }
      if (isTest) { testCount++; }
      if (isImport && !includeImports) { return; }
      if (isTest && !this.includeTests) { return; }
      visible.push(loc);
    });

    // Tests, when included, are classified into their natural kind alongside the rest
    // (no separate group). Structural locations (type defs, interface/super decls,
    // definitions, implementations) are merged in even when they aren't among the
    // references, so those sections actually render.
    const locKey = (l: vscode.Location) => `${l.uri.fsPath}:${l.range.start.line}`;
    const seenStructural = new Set(visible.map(locKey));
    const extras: vscode.Location[] = [];
    for (const loc of [...typeDefLocations, ...interfaceLocations, ...defLocations, ...implLocations]) {
      const k = locKey(loc);
      if (seenStructural.has(k)) { continue; }
      seenStructural.add(k); extras.push(loc);
    }

    const classified = classifyLocations(
      [...visible, ...extras],
      typeDefLocations, defLocations, implLocations, interfaceLocations
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

    // Float the "current" item (and its file) to the top of whichever group holds it.
    const floatCurrentFirst = (files: FileGroupData[]): FileGroupData[] => {
      const fi = files.findIndex(f => f.items.some(it => it.isCurrent));
      if (fi < 0) { return files; }
      if (fi > 0) { files.unshift(files.splice(fi, 1)[0]); }
      const top = files[0];
      const ii = top.items.findIndex(it => it.isCurrent);
      if (ii > 0) { top.items.unshift(top.items.splice(ii, 1)[0]); }
      return files;
    };

    const ORDER: LocationKind[] = ['typeDefinition', 'interface', 'definition', 'implementation', 'reference'];
    const groups: GroupData[] = [];

    let definitionCount = 0;
    for (const kind of ORDER) {
      const locs = classified.filter(c => c.kind === kind).map(c => c.location);
      if (!locs.length) { continue; }
      const items = await Promise.all(locs.map(toItemData));
      // The "Definitions" chip hides this section from the view, but its count is still
      // reported so the chip can show how many are hidden.
      if (kind === 'definition') {
        definitionCount = items.length;
        if (this.hideDefinitions) { continue; }
      }
      groups.push({ kind, files: floatCurrentFirst(toFileGroups(items)), totalItems: items.length });
    }

    return {
      symbolName,
      includeImports,
      includeTests: this.includeTests,
      hideDefinitions: this.hideDefinitions,
      currentClassOnly: this.currentClassOnly,
      totalCount: rawLocations.length,
      visibleCount: groups.reduce((s, g) => s + g.totalItems, 0),
      counts: {
        imports: importCount, tests: testCount,
        definitions: definitionCount, currentClass: currentClassCount,
      },
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
.chip-imports { background: #569cd628; color: #7ab8f5; border-color: #569cd655; }
.chip-tests { background: #c586c028; color: #d8a0d6; border-color: #c586c055; }
.chip-definitions { background: #4ec9b028; color: #4ec9b0; border-color: #4ec9b055; }
.chip-currentclass { background: #e2c08d28; color: #e2c08d; border-color: #e2c08d55; }
/* Off = excluded from results: dimmed and de-saturated. */
.chip.off { opacity: 0.4; background: transparent; color: var(--vscode-descriptionForeground); border-color: var(--vscode-panel-border); }
.stats { font-size: 0.74em; color: var(--vscode-descriptionForeground); }

.results { padding: 4px 0 16px; }

/* Loading screen — a single, polished progress bar (no separate spinner). */
.loading {
  margin: 26px 16px 0;
  padding: 22px 20px;
  display: flex; flex-direction: column; align-items: stretch; gap: 14px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
}
.loading .l-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.loading .l-label {
  font-size: 0.85em; font-weight: 600; color: var(--vscode-foreground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.loading .l-count {
  font-size: 0.74em; color: var(--vscode-descriptionForeground);
  font-variant-numeric: tabular-nums; flex-shrink: 0;
}
.bar {
  width: 100%; height: 5px; border-radius: 100px;
  background: var(--vscode-panel-border); overflow: hidden; position: relative;
}
.bar > i {
  display: block; height: 100%; border-radius: 100px;
  background: linear-gradient(90deg,
    var(--vscode-progressBar-background, var(--vscode-focusBorder)),
    color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-focusBorder)) 55%, transparent));
  transition: width 0.2s ease;
}
.bar.indeterminate > i {
  position: absolute; width: 40%;
  background: linear-gradient(90deg, transparent,
    var(--vscode-progressBar-background, var(--vscode-focusBorder)), transparent);
  animation: jn-indet 1.2s ease-in-out infinite;
}
@keyframes jn-indet { 0% { left: -40%; } 100% { left: 100%; } }

/* Inline "loading the rest of the project" progress, shown below the current-class
   results while the Current class chip is toggled off (or during a progressive peek). */
.expand {
  margin: 8px 14px 0; padding: 10px 12px 2px;
  display: flex; flex-direction: column; gap: 8px;
  border-top: 1px solid var(--vscode-panel-border);
}
.expand .l-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.expand .l-label {
  font-size: 0.78em; font-weight: 600; color: var(--vscode-descriptionForeground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.expand .l-count {
  font-size: 0.72em; color: var(--vscode-descriptionForeground);
  font-variant-numeric: tabular-nums; flex-shrink: 0;
}

.idle {
  padding: 20px 14px; color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}
.idle-hint { margin-top: 8px; font-style: italic; font-size: 0.92em; }
.status { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-style: normal; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status.ok { color: var(--vscode-testing-iconPassed, #4ec9b0); }
.status.ok .dot { background: var(--vscode-testing-iconPassed, #4ec9b0); }
.status.wait { color: var(--vscode-charts-yellow, #e2c08d); }
.status.wait .dot { background: var(--vscode-charts-yellow, #e2c08d); animation: jn-pulse 1s ease-in-out infinite; }
@keyframes jn-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
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
/* Hover = transient pointer feedback; kept visually distinct from selection. */
.row:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground, inherit); }

/* Selection = the row currently open/previewed. Uses VS Code's list selection pair
   (like the native References/Search views) so text keeps full contrast against the
   highlight — the editor's selection color is translucent and washes out muted text.
   The selection foreground is forced onto the children, which set their own colors. */
.row.selected,
.row.selected:hover { background: var(--vscode-list-inactiveSelectionBackground); }
.row.selected, .row.selected .row-loc, .row.selected .row-code {
  color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground));
}
body.focused .row.selected,
body.focused .row.selected:hover { background: var(--vscode-list-activeSelectionBackground); }
body.focused .row.selected,
body.focused .row.selected .row-loc,
body.focused .row.selected .row-code {
  color: var(--vscode-list-activeSelectionForeground);
}

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
/* Class names get the editor theme's class-symbol color, like in the editor. */
.tok-class { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
/* Keep the class color readable on a selected (highlighted) row. */
.row.selected .row-code .tok-class,
body.focused .row.selected .row-code .tok-class { color: inherit; }

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
  <div class="header"><div class="symbol-name">Codenav References</div></div>
  <div class="results">
    <div class="idle">Place cursor on a Java symbol and press <kbd>Shift+Alt+F12</kbd></div>
  </div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let _pt, _sel = -1, _rows = [], _empty = true, _idle = true, _javaReady = false;

const LABELS = {
  typeDefinition: 'Type Definitions', interface: 'Interface', definition: 'Definitions',
  implementation: 'Implementations', reference: 'References', test: 'Tests'
};

window.addEventListener('message', ({ data }) => {
  if (data.command === 'ready') { _javaReady = data.ready; if (_idle) { renderIdle(); } return; }
  if (data.command === 'loading') { renderLoading(data); return; }
  if (data.command === 'message') { renderMessage(data.text); return; }
  if (data.command === 'expandStart') { showExpand('Loading whole-project references…'); return; }
  if (data.command === 'expandProgress') { showExpand(data.label, data.done, data.total); return; }
  if (data.command === 'expandEnd') { hideExpand(); return; }
  if (data.command !== 'update') { return; }
  document.getElementById('root').innerHTML = buildHtml(data.data);
  _empty = !(data.data.groups && data.data.groups.length);
  _idle = false;
  refreshRows();
  selectCurrent();
  document.getElementById('results')?.focus();
  // Every search scrolls the view all the way to the top: "current" is floated to the
  // top of the list, so this shows it in context. Runs last (after selectCurrent's
  // scrollIntoView and the focus() call) so nothing scrolls us back down. Covers both a
  // fresh peek and a same-token re-peek (which just moves the "current" marker).
  window.scrollTo({ top: 0 });
});

function renderIdle() {
  _idle = true; _empty = true; _rows = []; _sel = -1;
  const status = _javaReady
    ? '<span class="status ok"><span class="dot"></span>Ready</span>'
    : '<span class="status wait"><span class="dot"></span>Java language server starting…</span>';
  const hint = _javaReady
    ? 'Place the cursor on a Java symbol and press <kbd>Shift+Alt+F12</kbd>.'
    : 'Peek will be available once the Java language server has started.';
  document.getElementById('root').innerHTML =
    '<div class="header"><div class="symbol-name">Codenav References</div></div>'
    + '<div class="results"><div class="idle">' + status + '<div class="idle-hint">' + hint + '</div></div></div>';
}

function renderLoading(d) {
  const hasTotal = typeof d.total === 'number' && d.total > 0;
  const pct = hasTotal ? Math.min(100, Math.round((d.done || 0) / d.total * 100)) : 0;
  const bar = hasTotal
    ? '<div class="bar"><i style="width:' + pct + '%"></i></div>'
    : '<div class="bar indeterminate"><i></i></div>';
  const count = hasTotal ? '<div class="l-count">' + (d.done || 0) + ' / ' + d.total + '</div>' : '';
  document.getElementById('root').innerHTML =
    '<div class="header"><div class="symbol-name">' + esc(d.symbolName || '') + '</div></div>'
    + '<div class="results" id="results" tabindex="-1"><div class="loading">'
    + '<div class="l-head"><span class="l-label">' + esc(d.label || 'Loading…') + '</span>' + count + '</div>'
    + bar
    + '</div></div>';
  _rows = []; _sel = -1; _empty = true; _idle = false;
  document.getElementById('results')?.focus();
}

function renderMessage(text) {
  document.getElementById('root').innerHTML =
    '<div class="header"><div class="symbol-name">Codenav References</div></div>'
    + '<div class="results" id="results" tabindex="-1"><div class="empty">' + esc(text || '') + '</div></div>';
  _rows = []; _sel = -1; _empty = true; _idle = false;
}

// Inline progress shown *below* the current results while the rest of the project loads.
// It is appended to the results list (the current-class rows stay visible); a later
// 'update' re-render replaces the whole list and drops it.
function showExpand(label, done, total) {
  const results = document.getElementById('results');
  if (!results) { return; }
  let el = document.getElementById('expand');
  if (!el) { el = document.createElement('div'); el.id = 'expand'; el.className = 'expand'; results.appendChild(el); }
  const hasTotal = typeof total === 'number' && total > 0;
  const pct = hasTotal ? Math.min(100, Math.round((done || 0) / total * 100)) : 0;
  const bar = hasTotal
    ? '<div class="bar"><i style="width:' + pct + '%"></i></div>'
    : '<div class="bar indeterminate"><i></i></div>';
  const count = hasTotal ? '<span class="l-count">' + (done || 0) + ' / ' + total + '</span>' : '';
  el.innerHTML = '<div class="l-head"><span class="l-label">' + esc(label || 'Loading…') + '</span>' + count + '</div>' + bar;
}
function hideExpand() { document.getElementById('expand')?.remove(); }

function selectCurrent() {
  const i = _rows.findIndex(r => r.dataset.current === '1');
  if (i >= 0) { select(i, false); } else { _sel = -1; }
}

function buildHtml(d) {
  const hidden = Math.max(0, d.totalCount - d.visibleCount);
  const stats = hidden > 0
    ? d.visibleCount + ' of ' + d.totalCount + ' · ' + hidden + ' hidden'
    : d.visibleCount + ' result' + (d.visibleCount === 1 ? '' : 's');

  let out = '<div class="header">'
    + '<div class="symbol-name">' + esc(d.symbolName) + '</div>'
    + '<div class="chips">'
    + chip('imports', d.includeImports, '{ }', 'Imports', d.counts.imports, 'chip-imports')
    + chip('tests', d.includeTests, '🧪', 'Tests', d.counts.tests, 'chip-tests')
    + chip('definitions', !d.hideDefinitions, '◆', 'Definitions', d.counts.definitions, 'chip-definitions')
    + chip('currentClass', d.currentClassOnly, '◉', 'Current class', d.counts.currentClass, 'chip-currentclass',
        d.currentClassOnly
          ? 'Showing current class only — click to load the whole project'
          : 'Showing the whole project — click to limit to the current class')
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
          + (item.isCurrent ? ' data-current="1"' : '')
          + ' data-uri="' + esc(item.uri) + '"'
          + ' data-line="' + item.line + '"'
          + ' data-col="' + item.column + '">'
          + locLabel + current
          + '<span class="row-code">' + highlightCode(item.lineText) + '</span>'
          + '</div>';
      });
    });

    out += '</div>';
  });

  return out + '</div>';
}

function chip(key, active, icon, label, count, cls, titleOverride) {
  // Active = these results are included; off = excluded.
  const title = titleOverride
    || ((active ? 'Including' : 'Excluding') + ' ' + label.toLowerCase() + ' — click to toggle');
  return '<button class="chip ' + cls + (active ? '' : ' off') + '" data-key="' + key + '"'
    + ' title="' + esc(title) + '">'
    + icon + ' ' + label + (count ? ' ' + count : '') + '</button>';
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
  if (r) {
    // Click = select + preview (unfocused), keeping focus in the pane so the
    // user can keep scrolling with the arrow keys. Enter is what opens/focuses.
    const i = _rows.indexOf(r);
    if (i >= 0) { select(i, true); }
    document.getElementById('results')?.focus();
  }
});

// Hover intentionally does NOT move the selection — it stays a separate, purely
// visual cue (CSS :hover) so the currently open/previewed row remains distinct.

document.addEventListener('keydown', e => {
  if      (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(_sel + 1, _rows.length - 1), true); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); select(Math.max(_sel - 1, 0), true); }
  else if (e.key === 'Enter' && _sel >= 0) { navigateTo(_rows[_sel]); }
  else if (e.key === 'Escape') {
    // With no results there is nothing to "return" to — just hand focus back to
    // the editor. Otherwise move the selection to the "current" (origin) row so
    // it's visually distinct, then open it in the editor.
    if (_empty) { vscode.postMessage({ command: 'focusEditor' }); return; }
    selectCurrent();
    // "current" is floated to the very top of the list — scroll all the way up so it's
    // shown in context (the first group) rather than wherever we were scrolled.
    window.scrollTo({ top: 0 });
    if (_sel >= 0) { navigateTo(_rows[_sel]); }
    else { vscode.postMessage({ command: 'gotoCurrent' }); }
  }
});

// Track pane focus so the selection highlight matches the editor's list behavior.
const setFocused = (on) => document.body.classList.toggle('focused', on);
window.addEventListener('focus', () => setFocused(true));
window.addEventListener('blur', () => setFocused(false));
setFocused(document.hasFocus());

renderIdle(); // initial screen until results or a readiness update arrives

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

// Escape, then tint class-name-shaped tokens (PascalCase: an uppercase start with at
// least one lowercase letter, so ALL-CAPS constants and single-letter generics aren't
// matched). Safe to regex over the escaped text: HTML entities never start uppercase
// and identifier chars [A-Za-z0-9_$] are untouched by escaping.
function highlightCode(s) {
  return esc(s).replace(/\b[A-Z][A-Za-z0-9_$]*[a-z][A-Za-z0-9_$]*\b/g,
    m => '<span class="tok-class">' + m + '</span>');
}
</script>
</body>
</html>`;
}
