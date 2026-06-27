// Pure, VSCode-free orchestration of the tiered (+2-deep) graph build. This is the
// single source of truth for *which* classes are loaded around a selection and how
// each is classified — kept free of `vscode` and the webview so it can be unit-tested
// with a fake class-expander (see __tests__/tieredGraphBuilder.test.ts).
//
// Terminology (see CLAUDE.md → "Graph terminology"):
//   selected — the centre the build is rooted at            (hop 0)
//   active   — its direct callers + dependencies            (hop 1)
//   inactive — each active node's own callers + deps         (hop 2)
//   shadow   — each inactive node's own callers + deps       (hop 3, loaded frontier)
//
// The build runs three expansion passes (center, then the active ring, then the
// inactive ring). Because each pass expands the *previous* ring, every node up to and
// including the inactive tier has its full neighbourhood fetched and present in the
// model — so selecting any visible node (active or inactive) never needs a fresh
// fetch. Shadow nodes are the loaded boundary: their existence and their edges back to
// the inactive ring are known, but their own neighbourhoods are not expanded.

import { FocusedGraphNode, FocusedGraphEdge, GraphStageUpdate } from './focusedGraphTypes';

export type NodeTier = 'selected' | 'active' | 'inactive' | 'shadow';

// The tier label carried on the streamed webview messages. The webview lumps the
// selected node in with the active ring (it tracks the selection separately), so the
// wire vocabulary has three values while the model has four.
export type EmitTier = 'active' | 'inactive' | 'shadow';

export interface TieredNode {
  id: string;            // `${uri}:${line}`
  name: string;
  uri: string;
  line: number;
  kind: FocusedGraphNode['kind'];
  tags: string[];
  tier: NodeTier;
  expanded: boolean;     // true once this node's own neighbourhood was fetched
  // Authoritative caller/dependency counts — exact for any expanded node (its own
  // expansion contributes all of its edges). -1 means "not yet expanded" (a shadow
  // node on the frontier), so the count isn't known.
  callers: number;
  deps: number;
}

export interface TieredGraph {
  selectedId: string | null;
  nodes: Map<string, TieredNode>;
  edges: FocusedGraphEdge[];
}

// Messages emitted to the host (the graph webview consumes these verbatim).
export type TieredMessage =
  | (GraphStageUpdate & { command: 'stage'; seqId: number; tier: EmitTier; forUri: string })
  | { command: 'activeDone'; seqId: number }
  | { command: 'counts'; seqId: number; id: string; callers: number; deps: number }
  | { command: 'buildDone'; seqId: number };

// Expand one class, emitting its neighbourhood stage by stage. In production this is
// `buildFocusedGraph`; tests inject a fake backed by an in-memory project.
export type ExpandClass = (
  uri: string,
  onStage: (update: GraphStageUpdate) => void,
  isCancelled: () => boolean,
) => Promise<void>;

export interface TieredBuildOptions {
  centerUri: string;
  seqId: number;
  expand: ExpandClass;
  /** Sink for streamed updates (webview postMessage in production). Optional. */
  emit?: (msg: TieredMessage) => void;
  isCancelled?: () => boolean;
}

/**
 * Build the tiered neighbourhood around `centerUri`, streaming progressive updates via
 * `emit` and returning the accumulated model. Each unique file is expanded at most
 * once; the returned model classifies every node into a tier and flags whether its
 * neighbourhood was fetched.
 */
export async function buildTieredGraph(opts: TieredBuildOptions): Promise<TieredGraph> {
  const { centerUri, seqId, expand } = opts;
  const emit = opts.emit ?? (() => {});
  const isCancelled = opts.isCancelled ?? (() => false);

  const graph: TieredGraph = { selectedId: null, nodes: new Map(), edges: [] };
  const edgeKeys = new Set<string>();
  const expandedUris = new Set<string>();
  const seen = new Set<string>([centerUri]);   // files already classified/queued

  const addEdge = (e: FocusedGraphEdge) => {
    const k = e.from + '|' + e.to;
    if (!edgeKeys.has(k)) { edgeKeys.add(k); graph.edges.push(e); }
  };
  // Insert a node the first time it is discovered; never downgrade an existing tier
  // (a node reached first as active stays active even if a later ring links to it).
  const upsert = (n: FocusedGraphNode, tier: NodeTier): TieredNode => {
    let tn = graph.nodes.get(n.id);
    if (!tn) {
      tn = { id: n.id, name: n.name, uri: n.uri, line: n.line, kind: n.kind, tags: n.tags, tier, expanded: false, callers: -1, deps: -1 };
      graph.nodes.set(n.id, tn);
    }
    return tn;
  };

  // Expand one file: fold its stages into the model, forward them to `emit`, and
  // return the URIs of newly-discovered neighbour files (the next ring to expand).
  // `tier` is both the model tier for discovered neighbours and the wire tier label.
  const expandFile = async (uri: string, tier: EmitTier): Promise<string[]> => {
    if (expandedUris.has(uri)) { return []; }
    expandedUris.add(uri);
    const nextRing: string[] = [];
    let expandedId: string | null = null;
    await expand(uri, (update) => {
      if (isCancelled()) { return; }
      emit({ command: 'stage', seqId, tier, forUri: uri, ...update });
      if (update.stage === 'center') {
        const tn = upsert(update.node, uri === centerUri ? 'selected' : tier);
        tn.expanded = true;
        expandedId = tn.id;
        if (uri === centerUri) { graph.selectedId = tn.id; }
      } else {
        for (const n of update.nodes) {
          upsert(n, tier);
          if (!seen.has(n.uri)) { seen.add(n.uri); nextRing.push(n.uri); }
        }
        for (const e of update.edges) { addEdge(e); }
      }
    }, isCancelled);

    // Record this node's authoritative counts now that its own neighbourhood is fully
    // in the model. Exact for any expanded node — so the selected/active/inactive tiers
    // always report correct counts, no matter which other rings have streamed in (this
    // is what lets "select an inactive node" show the right count from already-loaded
    // data). Emitted so the host can show it without recounting partial live edges.
    if (expandedId && !isCancelled()) {
      const tn = graph.nodes.get(expandedId);
      if (tn) {
        let callers = 0, deps = 0;
        for (const e of graph.edges) {
          if (e.to === expandedId) { callers++; }
          else if (e.from === expandedId) { deps++; }
        }
        tn.callers = callers; tn.deps = deps;
        emit({ command: 'counts', seqId, id: expandedId, callers, deps });
      }
    }
    return nextRing;
  };

  // ── Pass 1: selected node + its active ring ────────────────────────────────────
  const activeRing = await expandFile(centerUri, 'active');
  if (isCancelled()) { return graph; }
  emit({ command: 'activeDone', seqId });

  // ── Pass 2: inactive ring (each active node's neighbourhood) ────────────────────
  const inactiveRing: string[] = [];
  for (const uri of activeRing) {
    if (isCancelled()) { return graph; }
    inactiveRing.push(...await expandFile(uri, 'inactive'));
  }
  if (isCancelled()) { return graph; }

  // ── Pass 3: shadow ring (each inactive node's neighbourhood — the frontier) ──────
  for (const uri of inactiveRing) {
    if (isCancelled()) { break; }
    await expandFile(uri, 'shadow');
  }

  if (!isCancelled()) { emit({ command: 'buildDone', seqId }); }
  return graph;
}
