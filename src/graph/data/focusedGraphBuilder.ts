// Orchestrates the hybrid graph build: tree-sitter for the current file (instant),
// LSP for callers and siblings (async, project-wide). Results are emitted stage by
// stage so the webview can render progressively without waiting for all data.
//
// Stage order and data source:
//   1. center       — tree-sitter parse of the active file (~5 ms, no LSP)
//   2. dependencies — workspace-symbol lookup per field type + tree-sitter parse (~50 ms)
//   3. callers      — LSP reference provider on the class name (~200–500 ms)
//   4. siblings     — LSP implementation provider on the parent class (~200 ms, optional)

import * as vscode from 'vscode';
import { parseSingleFile, readFileText } from './singleFileParser';
import { FocusedGraphNode, FocusedGraphEdge, StageCallback } from './focusedGraphTypes';
import { ParsedType } from '../core/types';

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

// ── builder ────────────────────────────────────────────────────────────────────

export async function buildFocusedGraph(
  uri: vscode.Uri,
  onStage: StageCallback,
  isCancelled: Cancelled = () => false
): Promise<void> {
  // ── Stage 1: center — tree-sitter, instant ──────────────────────────────────
  const parsed = await parseSingleFile(uri);
  if (isCancelled()) { return; }

  const centerType = parsed.find(p => !p.tags?.includes('test')) ?? parsed[0];
  if (!centerType) { return; }

  const uriStr = uri.toString();
  const center = toNode(centerType, uriStr, 'center');
  onStage({ stage: 'center', node: center });

  // ── Stage 2: dependencies — workspace symbol lookup + tree-sitter ───────────
  // Resolve field type simple names using the center file's imports for disambiguation.
  const fileText = await readFileText(uri);
  if (isCancelled()) { return; }

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

  if (isCancelled()) { return; }

  const depNodes: FocusedGraphNode[] = [];
  const depEdges: FocusedGraphEdge[] = [];
  const seen = new Set<string>([center.id]);

  for (const res of [...fieldResolutions, ...inheritanceResolutions]) {
    if (!res) { continue; }
    const id = nodeId(res.uri, res.type.line);
    if (seen.has(id)) { continue; }
    seen.add(id);
    const node = toNode(res.type, res.uri, 'dependency');
    depNodes.push(node);
    depEdges.push({ from: center.id, to: id, kind: res.kind });
  }

  if (depNodes.length > 0) {
    onStage({ stage: 'dependencies', nodes: depNodes, edges: depEdges });
  }
  if (isCancelled()) { return; }

  // ── Stage 3: callers — LSP reference provider ───────────────────────────────
  const namePos = findNamePosition(fileText, centerType.name, centerType.line);
  const refs = await execLocs('vscode.executeReferenceProvider', uri, namePos);
  if (isCancelled()) { return; }

  // Each unique workspace file (excluding the center itself) that references this
  // class likely contains a caller class. Parse each to get its declaration.
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
  if (isCancelled()) { return; }

  const callerNodes: FocusedGraphNode[] = [];
  const callerEdges: FocusedGraphEdge[] = [];
  const callerSeen = new Set<string>();

  for (const res of callerResolutions) {
    if (!res) { continue; }
    const id = nodeId(res.uri, res.type.line);
    if (callerSeen.has(id) || id === center.id) { continue; }
    callerSeen.add(id);
    const node = toNode(res.type, res.uri, 'caller');
    callerNodes.push(node);
    callerEdges.push({ from: id, to: center.id, kind: 'calls' });
  }

  if (callerNodes.length > 0) {
    onStage({ stage: 'callers', nodes: callerNodes, edges: callerEdges });
  }
  if (isCancelled()) { return; }

  // ── Stage 4: siblings — LSP implementation provider on the parent ───────────
  const parentRes = inheritanceResolutions.find(r => r?.kind === 'extends');
  if (!parentRes) { return; }

  const parentUri = vscode.Uri.parse(parentRes.uri);
  const parentText = await readFileText(parentUri);
  const parentNamePos = findNamePosition(parentText, parentRes.type.name, parentRes.type.line);
  const implLocs = await execLocs('vscode.executeImplementationProvider', parentUri, parentNamePos);
  if (isCancelled()) { return; }

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
  if (isCancelled()) { return; }

  const siblingNodes: FocusedGraphNode[] = [];
  const siblingSeen = new Set<string>();

  for (const res of siblingResolutions) {
    if (!res) { continue; }
    const id = nodeId(res.uri, res.type.line);
    if (siblingSeen.has(id) || id === center.id) { continue; }
    siblingSeen.add(id);
    siblingNodes.push(toNode(res.type, res.uri, 'sibling'));
  }

  if (siblingNodes.length > 0) {
    onStage({ stage: 'siblings', nodes: siblingNodes, edges: [] });
  }
}

// ── traverse expansion ──────────────────────────────────────────────────────────
// Called on demand when the user activates the Traverse button. Expands one extra
// hop outward: who calls the existing callers, and what do the existing deps depend on.

export async function buildTraverseExpansion(
  existingNodes: FocusedGraphNode[],
  onStage: StageCallback,
  isCancelled: Cancelled = () => false
): Promise<void> {
  const existingIds = new Set(existingNodes.map(n => n.id));

  // ── Level-2 callers ──────────────────────────────────────────────────────────
  const callerNodes = existingNodes.filter(n => n.role === 'caller');
  const caller2Nodes: FocusedGraphNode[] = [];
  const caller2Edges: FocusedGraphEdge[] = [];
  const caller2Seen = new Set<string>();

  await Promise.all(callerNodes.map(async (callerNode) => {
    if (isCancelled()) { return; }
    const callerUri = vscode.Uri.parse(callerNode.uri);
    const text = await readFileText(callerUri);
    if (isCancelled()) { return; }
    const namePos = findNamePosition(text, callerNode.name, callerNode.line);
    const refs = await execLocs('vscode.executeReferenceProvider', callerUri, namePos);
    if (isCancelled()) { return; }

    const refUris = [...new Set(
      refs.filter(r => isWorkspace(r.uri) && r.uri.toString() !== callerNode.uri)
          .map(r => r.uri.toString())
    )];

    for (const refUri of refUris) {
      const parsed = await parseSingleFile(vscode.Uri.parse(refUri));
      const type = parsed.find(p => !p.tags?.includes('test'));
      if (!type) { continue; }
      const id = nodeId(refUri, type.line);
      if (caller2Seen.has(id) || existingIds.has(id)) { continue; }
      caller2Seen.add(id);
      caller2Nodes.push(toNode(type, refUri, 'caller2'));
      caller2Edges.push({ from: id, to: callerNode.id, kind: 'calls' });
    }
  }));

  if (isCancelled()) { return; }
  if (caller2Nodes.length > 0) {
    onStage({ stage: 'traverse-callers', nodes: caller2Nodes, edges: caller2Edges });
  }

  // ── Level-2 dependencies ─────────────────────────────────────────────────────
  const depNodes = existingNodes.filter(n => n.role === 'dependency');
  const dep2Nodes: FocusedGraphNode[] = [];
  const dep2Edges: FocusedGraphEdge[] = [];
  const dep2Seen = new Set<string>();

  await Promise.all(depNodes.map(async (depNode) => {
    if (isCancelled()) { return; }
    const depUri = vscode.Uri.parse(depNode.uri);
    const depParsed = await parseSingleFile(depUri);
    const depType = depParsed.find(p => p.name === depNode.name);
    if (!depType) { return; }

    await Promise.all(depType.fieldTypes.map(async (simpleName) => {
      if (isCancelled()) { return; }
      const fieldUri = await resolveTypeUri(simpleName);
      if (!fieldUri || !isWorkspace(fieldUri)) { return; }
      const fieldParsed = await parseSingleFile(fieldUri);
      const fieldType = fieldParsed.find(p => p.name === simpleName);
      if (!fieldType) { return; }
      const id = nodeId(fieldUri.toString(), fieldType.line);
      if (dep2Seen.has(id) || existingIds.has(id)) { return; }
      dep2Seen.add(id);
      dep2Nodes.push(toNode(fieldType, fieldUri.toString(), 'dependency2'));
      dep2Edges.push({ from: depNode.id, to: id, kind: 'uses' });
    }));
  }));

  if (isCancelled()) { return; }
  if (dep2Nodes.length > 0) {
    onStage({ stage: 'traverse-deps', nodes: dep2Nodes, edges: dep2Edges });
  }
}
