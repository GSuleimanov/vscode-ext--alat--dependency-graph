// Orchestrates the hybrid graph build: tree-sitter for the current file (instant),
// LSP for callers and siblings (async, project-wide). Results are emitted stage by
// stage so the webview can render progressively without for all data.
//
// Stage order and data source:
//   1. center       — tree-sitter parse of the active file (~5 ms, no LSP)
//   2. dependencies — workspace-symbol lookup per field type + tree-sitter parse (~50 ms)
//   3. callers      — LSP reference provider on the class name (~200–500 ms)
//   4. siblings     — LSP implementation provider on the parent class (~200 ms, optional)
//
// Every expansion is memoized in the expansion cache (see expansionCache.ts). A node
// expanded once is replayed from cache — no LSP — as long as it stays valid, so a
// large graph settles after a single pass and focusing then clicking a node always
// reports the same neighbourhood. Cache validity is split: the intrinsic half
// (center + dependencies) is keyed on the file's own content hash, the extrinsic half
// (callers + siblings) on the workspace epoch (bumped on any save).

import * as vscode from 'vscode';
import { parseSingleFile, readFileText } from './singleFileParser';
import { FocusedGraphNode, FocusedGraphEdge, StageCallback } from './focusedGraphTypes';
import { ParsedType } from '../core/types';
import {
  Segment, ParentRef, currentEpoch, getExpansion, setExpansion, hashText,
} from './expansionCache';

type Cancelled = () => boolean;

// ── helpers ────────────────────────────────────────────────────────────────────

function nodeId(uri: string, line: number): string {
  return `${uri}:${line}`;
}

function toNode(p: ParsedType, uri: string, role: FocusedGraphNode['role']): FocusedGraphNode {
  return {
    id: nodeId(uri, p.line),
    name: p.name,
    uri,
    line: p.line,
    kind: p.kind,
    tags: p.tags ?? [],
    role,
  };
}

function isWorkspace(uri: vscode.Uri): boolean {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return uri.scheme === 'file' && (!ws || uri.fsPath.startsWith(ws));
}

const execLocs = (cmd: string, uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[]> =>
  Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(cmd, uri, pos))
    .then(r => r ?? []).catch(() => []);

/**
 * Find the character-level position of a class name identifier in file text.
 * Tree-sitter gives us the declaration's start line, which may be an annotation
 * line. We scan a small window around it to find the actual name token.
 */
function findNamePosition(text: string, name: string, hintLine: number): vscode.Position {
  const lines = text.split('\n');
  for (let i = Math.max(0, hintLine - 3); i < Math.min(lines.length, hintLine + 10); i++) {
    const col = lines[i].indexOf(name);
    if (col < 0) { continue; }
    const after = lines[i][col + name.length] ?? ' ';
    if (/[\s({<]/.test(after)) { return new vscode.Position(i, col); }
  }
  return new vscode.Position(hintLine, 0);
}

/**
 * Resolve a simple type name to a workspace file URI using the LSP workspace
 * symbol provider. Prefers exact name matches of class/interface/enum kind.
 */
async function resolveTypeUri(name: string): Promise<vscode.Uri | null> {
  try {
    const symbols = await Promise.resolve(
      vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', name
      )
    );
    if (!symbols?.length) { return null; }
    const TYPE_KINDS = new Set([
      vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum,
    ]);
    const match = symbols.find(s =>
      TYPE_KINDS.has(s.kind) && s.name === name && isWorkspace(s.location.uri)
    );
    return match?.location.uri ?? null;
  } catch {
    return null;
  }
}

/**
 * Definitive "is the language server indexed?" probe. The whole project is searched for
 * the centre's own class — which certainly exists in the workspace — so a non-empty hit
 * means the server has finished building its index. This is the fallback we fall back on
 * when a build's emptiness is ambiguous: an empty neighbourhood from an *indexed* server
 * is genuine (e.g. an API controller nobody calls) and safe to cache, whereas an empty
 * one from a still-starting server must not be. It is only consulted when cheaper, local
 * evidence of readiness is absent (see buildFocusedGraph), so most builds never run it.
 */
async function languageServerIndexed(name: string): Promise<boolean> {
  try {
    const symbols = await Promise.resolve(
      vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', name
      )
    );
    return !!symbols?.some(s => s.name === name);
  } catch {
    return false;
  }
}

// ── segment computation (each separately cacheable) ─────────────────────────────

interface IntrinsicResult {
  center: FocusedGraphNode;
  deps: Segment;
  parent: ParentRef | null;
  // Did tree-sitter see any declared type references (field types / extends / implements)?
  // Used as the local readiness signal: declared-but-unresolved deps mean the index is
  // still building, whereas a class that declares nothing has genuinely empty deps.
  hadNames: boolean;
}

/**
 * Intrinsic half: the centre node, its dependencies (field types) and inheritance
 * (extends/implements). Derived purely from the file's own content, so it stays
 * valid until that file changes.
 */
async function computeIntrinsic(uri: vscode.Uri, uriStr: string): Promise<IntrinsicResult | null> {
  const parsed = await parseSingleFile(uri);
  const centerType = parsed.find(p => !p.tags?.includes('test')) ?? parsed[0];
  if (!centerType) { return null; }
  const center = toNode(centerType, uriStr, 'center');

  // Resolve field type simple names using the centre file's imports for disambiguation.
  const fieldResolutions = await Promise.all(
    centerType.fieldTypes.map(async (simpleName) => {
      const importedFqn = (centerType.imports ?? []).find(imp => imp.endsWith('.' + simpleName));
      const searchName = importedFqn ? importedFqn.split('.').pop()! : simpleName;
      const depUri = await resolveTypeUri(searchName);
      if (!depUri || !isWorkspace(depUri)) { return null; }
      const depParsed = await parseSingleFile(depUri);
      const depType = depParsed.find(p => p.name === searchName || p.name === simpleName);
      return depType ? { type: depType, uri: depUri.toString(), kind: 'uses' as const } : null;
    })
  );

  // Resolve extends/implements to workspace files.
  const inheritanceResolutions = await Promise.all(
    [...centerType.extendsNames.map(n => ({ n, k: 'extends' as const })),
     ...centerType.implementsNames.map(n => ({ n, k: 'implements' as const }))].map(
      async ({ n, k }) => {
        const iUri = await resolveTypeUri(n);
        if (!iUri || !isWorkspace(iUri)) { return null; }
        const ip = await parseSingleFile(iUri);
        const it = ip.find(p => p.name === n);
        return it ? { type: it, uri: iUri.toString(), kind: k } : null;
      }
    )
  );

  const depNodes: FocusedGraphNode[] = [];
  const depEdges: FocusedGraphEdge[] = [];
  const seen = new Set<string>([center.id]);
  for (const res of [...fieldResolutions, ...inheritanceResolutions]) {
    if (!res) { continue; }
    const id = nodeId(res.uri, res.type.line);
    if (seen.has(id)) { continue; }
    seen.add(id);
    depNodes.push(toNode(res.type, res.uri, 'dependency'));
    depEdges.push({ from: center.id, to: id, kind: res.kind });
  }

  const parentRes = inheritanceResolutions.find(r => r?.kind === 'extends');
  const parent: ParentRef | null = parentRes
    ? { uri: parentRes.uri, name: parentRes.type.name, line: parentRes.type.line }
    : null;

  const hadNames = centerType.fieldTypes.length
    + centerType.extendsNames.length + centerType.implementsNames.length > 0;

  return { center, deps: { nodes: depNodes, edges: depEdges }, parent, hadNames };
}

/**
 * Extrinsic: classes that reference this one (each unique workspace file, excluding
 * the centre, likely holds a caller class). Depends on the whole project.
 */
async function computeCallers(
  uri: vscode.Uri, uriStr: string, fileText: string, center: FocusedGraphNode
): Promise<Segment & { refsNonEmpty: boolean }> {
  const namePos = findNamePosition(fileText, center.name, center.line);
  const refs = await execLocs('vscode.executeReferenceProvider', uri, namePos);

  // Raw fact (not a verdict): did the reference provider return anything at all? A ready
  // server returns at least the declaration even when nothing calls the class — but some
  // servers omit it, so an empty result here is ambiguous. buildFocusedGraph resolves
  // that ambiguity (genuinely-uncalled vs. server-not-ready) rather than this function.
  const refsNonEmpty = refs.length > 0;

  const refUriStrings = [...new Set(
    refs
      .filter(r => isWorkspace(r.uri) && r.uri.toString() !== uriStr)
      .map(r => r.uri.toString())
  )];

  const callerResolutions = await Promise.all(
    refUriStrings.map(async (callerUriStr) => {
      const callerParsed = await parseSingleFile(vscode.Uri.parse(callerUriStr));
      const callerType = callerParsed.find(p => !p.tags?.includes('test'));
      return callerType ? { type: callerType, uri: callerUriStr } : null;
    })
  );

  const nodes: FocusedGraphNode[] = [];
  const edges: FocusedGraphEdge[] = [];
  const seen = new Set<string>();
  for (const res of callerResolutions) {
    if (!res) { continue; }
    const id = nodeId(res.uri, res.type.line);
    if (seen.has(id) || id === center.id) { continue; }
    seen.add(id);
    nodes.push(toNode(res.type, res.uri, 'caller'));
    edges.push({ from: id, to: center.id, kind: 'calls' });
  }
  return { nodes, edges, refsNonEmpty };
}

/**
 * Extrinsic: sibling implementations of the centre's parent class (no edges — they
 * are shown as loose context). Empty when the centre has no resolved `extends`.
 */
async function computeSiblings(
  uriStr: string, parent: ParentRef | null, center: FocusedGraphNode
): Promise<Segment> {
  if (!parent) { return { nodes: [], edges: [] }; }
  const parentUri = vscode.Uri.parse(parent.uri);
  let parentText: string;
  try { parentText = await readFileText(parentUri); } catch { return { nodes: [], edges: [] }; }

  const parentNamePos = findNamePosition(parentText, parent.name, parent.line);
  const implLocs = await execLocs('vscode.executeImplementationProvider', parentUri, parentNamePos);

  const siblingUriStrings = [...new Set(
    implLocs
      .filter(l => isWorkspace(l.uri) && l.uri.toString() !== uriStr)
      .map(l => l.uri.toString())
  )];

  const siblingResolutions = await Promise.all(
    siblingUriStrings.map(async (sibUriStr) => {
      const sibParsed = await parseSingleFile(vscode.Uri.parse(sibUriStr));
      const sibType = sibParsed.find(p => !p.tags?.includes('test'));
      return sibType ? { type: sibType, uri: sibUriStr } : null;
    })
  );

  const nodes: FocusedGraphNode[] = [];
  const seen = new Set<string>();
  for (const res of siblingResolutions) {
    if (!res) { continue; }
    const id = nodeId(res.uri, res.type.line);
    if (seen.has(id) || id === center.id) { continue; }
    seen.add(id);
    nodes.push(toNode(res.type, res.uri, 'sibling'));
  }
  return { nodes, edges: [] };
}

// ── builder ────────────────────────────────────────────────────────────────────

/**
 * Expand one class, emitting its neighbourhood stage by stage. Each stage is served
 * from the expansion cache when still valid, so a node expanded once is never
 * re-queried while browsing — and a focus/click of the same node always reports an
 * identical neighbourhood.
 */
export async function buildFocusedGraph(
  uri: vscode.Uri,
  onStage: StageCallback,
  isCancelled: Cancelled = () => false
): Promise<void> {
  const uriStr = uri.toString();

  // The file's own content hash gates the intrinsic half of the cache.
  let fileText: string;
  try { fileText = await readFileText(uri); } catch { return; }
  if (isCancelled()) { return; }

  const ownHash = hashText(fileText);
  const epoch = currentEpoch();
  const cached = getExpansion(uriStr);
  const intrinsicValid = !!cached && cached.ownHash === ownHash;
  const extrinsicValid = intrinsicValid && cached!.epoch === epoch;

  // ── Stage 1+2: centre + dependencies (intrinsic) ────────────────────────────
  let center: FocusedGraphNode;
  let deps: Segment;
  let parent: ParentRef | null;
  let hadNames = false;             // tree-sitter saw declared deps (fresh build only)
  if (intrinsicValid) {
    ({ center, deps, parent } = cached!);
  } else {
    const computed = await computeIntrinsic(uri, uriStr);
    if (!computed) { return; }
    ({ center, deps, parent, hadNames } = computed);
  }
  if (isCancelled()) { return; }

  onStage({ stage: 'center', node: center });
  if (isCancelled()) { return; }
  if (deps.nodes.length > 0) {
    onStage({ stage: 'dependencies', nodes: deps.nodes, edges: deps.edges });
  }
  if (isCancelled()) { return; }

  // ── Stage 3: callers (extrinsic) ────────────────────────────────────────────
  let callers: Segment;
  let refsNonEmpty = false;         // reference provider returned something (fresh build only)
  if (extrinsicValid) {
    callers = cached!.callers;
  } else {
    const computed = await computeCallers(uri, uriStr, fileText, center);
    callers = { nodes: computed.nodes, edges: computed.edges };
    refsNonEmpty = computed.refsNonEmpty;
  }
  if (isCancelled()) { return; }
  if (callers.nodes.length > 0) {
    onStage({ stage: 'callers', nodes: callers.nodes, edges: callers.edges });
  }
  if (isCancelled()) { return; }

  // ── Stage 4: siblings (extrinsic) ───────────────────────────────────────────
  const siblings: Segment = extrinsicValid
    ? cached!.siblings
    : await computeSiblings(uriStr, parent, center);
  if (isCancelled()) { return; }
  if (siblings.nodes.length > 0) {
    onStage({ stage: 'siblings', nodes: siblings.nodes, edges: siblings.edges });
  }

  // ── Readiness verdict: should this be cached? ───────────────────────────────
  // A neighbourhood resolved before the language server finished indexing would have
  // wrongly-empty deps/callers; cached, that emptiness would stick (replayed on every
  // re-select) until a save invalidates it, and the host would keep showing the loading
  // screen. So cache only once the server is provably ready. Crucially, "empty" is NOT
  // "not ready": an API controller legitimately has zero callers. We therefore decide
  // from positive evidence, preferring cheap local signals and only probing the index as
  // a last resort (so a warm build never pays for it):
  //   • a half that came from cache is already trustworthy;
  //   • any resolved dep proves the symbol index is up (so callers are too — that
  //     subsystem comes up no later);
  //   • any returned reference proves the reference provider is up;
  //   • a class that declares no deps has genuinely-empty deps, not a stalled index;
  //   • otherwise the emptiness is ambiguous — fall back to the index probe.
  let indexedMemo: boolean | undefined;
  const indexed = async () => indexedMemo ??= await languageServerIndexed(center.name);
  const depsResolved = deps.nodes.length > 0;
  const intrinsicReady = intrinsicValid || depsResolved || !hadNames || await indexed();
  const extrinsicReady = extrinsicValid || refsNonEmpty || depsResolved || await indexed();
  if (intrinsicReady && extrinsicReady) {
    setExpansion(uriStr, { ownHash, epoch, center, deps, parent, callers, siblings });
  }
}

/**
 * Recompute just the intrinsic dependency ring of a class — used to patch the graph
 * live when its file is saved (its callers come from other files and don't change).
 * Returns null if the file holds no parseable type.
 */
export async function expandDependencies(
  uri: vscode.Uri
): Promise<{ center: FocusedGraphNode; deps: Segment } | null> {
  const computed = await computeIntrinsic(uri, uri.toString());
  if (!computed) { return null; }
  return { center: computed.center, deps: computed.deps };
}
