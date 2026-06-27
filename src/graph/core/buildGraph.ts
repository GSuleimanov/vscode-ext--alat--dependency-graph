import { Graph, GraphEdge, GraphNode, ParsedType, EdgeKind } from './types';
import { Tags } from './tags';

// Cross-cutting role: a test type, detected by source path/name regardless of
// language. Applied during node build so it composes with language tags. Extension
// is left unconstrained so the same conventions work across languages.
const TEST_PATH = /\/(test|tests|it|integration-test)\//i;
const TEST_FILE = /(Test|Tests|TestCase|Spec|IT)\.[A-Za-z0-9]+$/;
const TEST_PREFIX = /(^|\/)test_[\w]+\.[A-Za-z0-9]+$/;

function isTestUri(uri: string): boolean {
  return TEST_PATH.test(uri) || TEST_FILE.test(uri) || TEST_PREFIX.test(uri);
}

/**
 * Build the resolved graph from parsed types.
 *
 * Dedup guarantee: nodes are keyed by FQN (package.Name). The same FQN parsed
 * twice merges tags (union) and keeps the first declaration's position. Edges
 * are resolved by simple name against the set of project types, so external
 * types are dropped and every edge connects two existing nodes. Duplicate edges
 * are collapsed.
 */
export function buildGraph(parsed: ParsedType[]): Graph {
  const nodeMap = new Map<string, GraphNode>();
  const fqn = (p: ParsedType) => (p.package ? `${p.package}.${p.name}` : p.name);

  for (const p of parsed) {
    const id = fqn(p);
    const existing = nodeMap.get(id);
    if (!existing) {
      nodeMap.set(id, {
        id, name: p.name, package: p.package, uri: p.uri, line: p.line,
        kind: p.kind, tags: [...new Set(p.tags ?? [])],
      });
    } else {
      existing.tags = [...new Set([...existing.tags, ...(p.tags ?? [])])];
    }
  }

  // Cross-cutting test tag (path/name based, language-agnostic).
  for (const node of nodeMap.values()) {
    if (isTestUri(node.uri) && !node.tags.includes(Tags.Test)) {
      node.tags.push(Tags.Test);
    }
  }

  const lastSeg = (s: string) => s.split('.').pop() ?? s;

  // simple name -> candidate FQNs (for resolving unqualified references). Keyed by
  // the last segment so a nested type (Outer.Inner) is reachable as `Inner` too.
  const bySimple = new Map<string, string[]>();
  for (const node of nodeMap.values()) {
    const key = lastSeg(node.name);
    const arr = bySimple.get(key) ?? [];
    arr.push(node.id);
    bySimple.set(key, arr);
  }

  // Resolve a simple name from a source file's perspective. Order of preference:
  // (1) an explicit import that pins the exact FQN, (2) a same-package type,
  // (3) the first candidate. Imports disambiguate same-named cross-package types.
  function resolve(simple: string, fromPkg: string, imports: string[]): string | undefined {
    const candidates = bySimple.get(simple);
    if (!candidates || candidates.length === 0) { return undefined; }
    if (candidates.length === 1) { return candidates[0]; }
    for (const imp of imports) {
      if (lastSeg(imp) === simple && nodeMap.has(imp)) { return imp; }
    }
    const samePkg = candidates.find(id => id === (fromPkg ? `${fromPkg}.${simple}` : simple));
    return samePkg ?? candidates[0];
  }

  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  function addEdge(from: string, simple: string, fromPkg: string, imports: string[], kind: EdgeKind) {
    const to = resolve(simple, fromPkg, imports);
    if (!to || to === from) { return; }
    const key = `${from}->${to}:${kind}`;
    if (edgeSet.has(key)) { return; }
    edgeSet.add(key);
    edges.push({ from, to, kind });
  }

  for (const p of parsed) {
    const from = fqn(p);
    const imports = p.imports ?? [];
    for (const e of p.extendsNames) { addEdge(from, e, p.package, imports, 'extends'); }
    for (const i of p.implementsNames) { addEdge(from, i, p.package, imports, 'implements'); }
    for (const t of p.fieldTypes) { addEdge(from, t, p.package, imports, 'uses'); }
  }

  return { nodes: [...nodeMap.values()], edges };
}
