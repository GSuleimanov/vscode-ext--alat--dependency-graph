// Session-scoped memory of resolved class neighbourhoods, so a node that has been
// expanded once is never re-resolved against the LSP while it stays valid. This is
// both a speed win (browsing a cached graph fires zero LSP queries) and a
// correctness win: a node's caller/dependency counts are computed exactly once, so
// focusing it and later clicking it can never disagree (the click just replays the
// cached expansion instead of re-querying a differently-loaded language server).
//
// Validity is split in two, because a neighbourhood has two kinds of data:
//   • intrinsic  — the node's own dependencies + inheritance. A pure function of its
//                  own file content, so it is valid as long as `ownHash` matches.
//   • extrinsic  — its callers + siblings. These depend on *other* files (who
//                  references it, who implements its parent), so they are valid only
//                  within the same workspace `epoch`. Any source-file save bumps the
//                  epoch, marking every node's extrinsic data as stale on next touch.

import { FocusedGraphNode, FocusedGraphEdge } from './focusedGraphTypes';

export interface Segment {
  nodes: FocusedGraphNode[];
  edges: FocusedGraphEdge[];
}

// Enough about the `extends` parent to re-query siblings without re-resolving
// inheritance from scratch when only the extrinsic data has gone stale.
export interface ParentRef {
  uri: string;
  name: string;
  line: number;
}

export interface CachedExpansion {
  ownHash: number;          // hash of the node's own file text — intrinsic validity
  epoch: number;            // workspace epoch when the extrinsic data was resolved
  center: FocusedGraphNode;
  deps: Segment;            // intrinsic: dependencies + inheritance
  parent: ParentRef | null; // intrinsic: the `extends` target, for sibling queries
  callers: Segment;         // extrinsic
  siblings: Segment;        // extrinsic
}

// Generous LRU bound: enough to hold a normal project's entire graph in memory, but
// a hard ceiling so browsing a huge monorepo can't grow the cache without limit. Map
// iteration order is insertion order, so the first key is always the least-recently
// used (get/set re-insert to refresh recency).
const MAX_ENTRIES = 4000;

const store = new Map<string, CachedExpansion>();
let epoch = 0;

// djb2 (xor variant) — same family as core/cache.ts so hashes stay cheap.
export function hashText(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

export function currentEpoch(): number { return epoch; }
export function bumpEpoch(): number { return ++epoch; }

export function getExpansion(uri: string): CachedExpansion | undefined {
  const entry = store.get(uri);
  if (entry) { store.delete(uri); store.set(uri, entry); }   // mark as most-recently-used
  return entry;
}

export function setExpansion(uri: string, entry: CachedExpansion): void {
  store.delete(uri);                  // re-insert at the end (most-recently-used)
  store.set(uri, entry);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;   // least-recently-used
    if (oldest === undefined) { break; }
    store.delete(oldest);
  }
}

export function invalidateExpansion(uri: string): void { store.delete(uri); }
export function clearExpansionCache(): void { store.clear(); }
