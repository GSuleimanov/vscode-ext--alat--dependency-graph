// VSCode glue around the pure project index (projectIndex.ts): enumerates the
// workspace with each language provider's own include/exclude globs, cold-builds
// the index in chunked background ticks (never blocking activation), persists a
// JSON snapshot under context.storageUri, and keeps the index fresh with O(1)
// per-save incremental updates. The graph builder reads the index through
// getProjectIndex(); the host awaits whenIndexReady() instead of polling any
// language server.

import * as vscode from 'vscode';
import { allProviders, providerForUri, LanguageProvider } from '../lang/registry';
import {
  createProjectIndex, defsFromTypes, refsFromTypes, FileFacts, ProjectIndex,
} from './projectIndex';
import { parseCached } from '../core/cache';
import { hashText } from './expansionCache';

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = 'projectIndex.json';
const CHUNK = 200;                       // files parsed per background tick

interface SnapshotEntry extends FileFacts { hash: number; }
interface Snapshot { version: number; files: SnapshotEntry[]; }

export interface IndexStatsMessage { symbols: number; bytes: number; }

export interface IndexServiceEvents {
  /** Cold-build progress, for the webview loading screen. */
  onProgress?: (indexed: number, total: number) => void;
  /** Index footprint after each (re)index / incremental update, for the status bar. */
  onStats?: (stats: IndexStatsMessage) => void;
}

let index: ProjectIndex | null = null;
const fileHashes = new Map<string, number>();
let readyResolve: (() => void) | null = null;
let readyPromise: Promise<void> | null = null;
let snapshotBytes = 0;

export function getProjectIndex(): ProjectIndex | null { return index; }

export function whenIndexReady(): Promise<void> {
  if (index?.ready()) { return Promise.resolve(); }
  readyPromise ??= new Promise<void>((res) => { readyResolve = res; });
  return readyPromise;
}

async function readText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

/** Parse one file into its index facts (defs + whole-file refs). */
function factsFor(provider: LanguageProvider, uriStr: string, text: string): FileFacts {
  const types = parseCached(uriStr, text, provider.parse);
  const refs = provider.refNames ? provider.refNames(text, uriStr) : refsFromTypes(types);
  return { uri: uriStr, defs: defsFromTypes(types, uriStr), refs };
}

// Directory names from an exclude glob's {a,b,c} group, used to filter watcher
// events (findFiles applies the glob itself; watchers can't).
function excludedSegments(exclude: string): Set<string> {
  const m = exclude.match(/\{([^}]*)\}/);
  return new Set(m ? m[1].split(',') : []);
}
function isExcluded(provider: LanguageProvider, uriStr: string): boolean {
  const dirs = excludedSegments(provider.exclude);
  if (uriStr.split('/').some(seg => dirs.has(seg))) { return true; }
  // Suffix patterns appended after the brace group (e.g. TypeScript's '**/*.d.ts').
  for (const part of provider.exclude.split(',')) {
    const m = part.match(/^\*\*\/\*(\.[\w.]+)$/);
    if (m && uriStr.endsWith(m[1])) { return true; }
  }
  return false;
}

/**
 * Initialize the project index: load the disk snapshot, re-index only files whose
 * content changed, watch for saves/creates/deletes, and persist. Chunked so the
 * extension host stays responsive during the one-time cold build.
 */
export async function initProjectIndex(
  context: vscode.ExtensionContext, events: IndexServiceEvents = {}
): Promise<void> {
  const idx = createProjectIndex();
  index = idx;

  // ── snapshot load (warm start) ────────────────────────────────────────────────
  const storageDir = context.storageUri;
  const snapshotUri = storageDir ? vscode.Uri.joinPath(storageDir, SNAPSHOT_FILE) : null;
  if (snapshotUri) {
    try {
      const raw = await readText(snapshotUri);
      snapshotBytes = Buffer.byteLength(raw);
      const snap = JSON.parse(raw) as Snapshot;
      if (snap.version === SNAPSHOT_VERSION && Array.isArray(snap.files)) {
        for (const f of snap.files) {
          idx.upsertFile(f.uri, f.defs, f.refs);
          fileHashes.set(f.uri, f.hash);
        }
      }
    } catch { /* no snapshot yet, or unreadable — cold build below covers it */ }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  async function saveSnapshot(): Promise<void> {
    if (!snapshotUri || !storageDir || index !== idx) { return; }
    const files: SnapshotEntry[] = idx.snapshot().map(f => ({
      ...f, hash: fileHashes.get(f.uri) ?? 0,
    }));
    const raw = JSON.stringify({ version: SNAPSHOT_VERSION, files } satisfies Snapshot);
    snapshotBytes = Buffer.byteLength(raw);
    try {
      await vscode.workspace.fs.createDirectory(storageDir);
      await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(raw));
    } catch { /* persistence is an optimization — the in-memory index still works */ }
    events.onStats?.({ symbols: idx.stats().symbols, bytes: snapshotBytes });
  }
  function scheduleSave(): void {
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = setTimeout(() => { saveTimer = null; void saveSnapshot(); }, 2000);
  }
  context.subscriptions.push({ dispose: () => { if (saveTimer) { clearTimeout(saveTimer); } } });

  // ── incremental updates ───────────────────────────────────────────────────────
  async function upsertUri(uri: vscode.Uri, textOverride?: string): Promise<void> {
    const uriStr = uri.toString();
    const provider = providerForUri(uriStr);
    if (!provider || isExcluded(provider, uriStr) || index !== idx) { return; }
    let text: string;
    try { text = textOverride ?? await readText(uri); } catch { return; }
    const hash = hashText(text);
    if (fileHashes.get(uriStr) === hash) { return; }
    await provider.init();
    const facts = factsFor(provider, uriStr, text);
    idx.upsertFile(uriStr, facts.defs, facts.refs);
    fileHashes.set(uriStr, hash);
    scheduleSave();
  }
  function removeUri(uri: vscode.Uri): void {
    const uriStr = uri.toString();
    if (!fileHashes.has(uriStr) || index !== idx) { return; }
    idx.removeFile(uriStr);
    fileHashes.delete(uriStr);
    scheduleSave();
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => { void upsertUri(doc.uri, doc.getText()); }),
    vscode.workspace.onDidCreateFiles((e) => { for (const u of e.files) { void upsertUri(u); } }),
    vscode.workspace.onDidDeleteFiles((e) => { for (const u of e.files) { removeUri(u); } }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const { oldUri, newUri } of e.files) { removeUri(oldUri); void upsertUri(newUri); }
    }),
  );
  // Catch changes made outside the editor (git checkout, codegen) per provider
  // glob. Includes are single globs (commas only appear inside braces) — don't
  // split them. upsertUri re-checks the provider + exclusions per event.
  for (const provider of allProviders()) {
    const watcher = vscode.workspace.createFileSystemWatcher(provider.include);
    watcher.onDidChange((u) => { void upsertUri(u); });
    watcher.onDidCreate((u) => { void upsertUri(u); });
    watcher.onDidDelete((u) => { removeUri(u); });
    context.subscriptions.push(watcher);
  }

  // ── cold build / reconcile against the live workspace ────────────────────────
  const found = await Promise.all(
    allProviders().map(async (p) => {
      try {
        await p.init();
        return await vscode.workspace.findFiles(p.include, p.exclude);
      } catch { return [] as vscode.Uri[]; }
    })
  );
  const liveUris = found.flat();
  const liveSet = new Set(liveUris.map(u => u.toString()));

  // Drop snapshot entries for files that no longer exist.
  for (const uriStr of [...fileHashes.keys()]) {
    if (!liveSet.has(uriStr)) { idx.removeFile(uriStr); fileHashes.delete(uriStr); }
  }

  // Index changed/new files, chunked so activation stays responsive.
  const total = liveUris.length;
  let processed = 0;
  for (const uri of liveUris) {
    if (index !== idx) { return; }   // superseded (e.g. re-init) — abandon quietly
    await upsertUri(uri);
    processed++;
    if (processed % CHUNK === 0) {
      events.onProgress?.(processed, total);
      await new Promise<void>((res) => setImmediate(res));
    }
  }
  events.onProgress?.(total, total);

  idx.markReady();
  readyResolve?.();
  readyResolve = null;
  await saveSnapshot();
}
