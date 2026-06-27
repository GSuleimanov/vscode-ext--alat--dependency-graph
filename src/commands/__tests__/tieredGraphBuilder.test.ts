import { test } from 'node:test';
import assert from 'node:assert';
import { buildTieredGraph, ExpandClass } from '../../graph/data/tieredGraphBuilder';
import { NodeRole } from '../../graph/data/focusedGraphTypes';

// These tests exercise the tiered-build orchestration with a fully in-memory project
// and a fake class-expander — no VSCode, no language server, no webview. They pin the
// two design guarantees: (1) the graph loads with every node classified into the right
// tier, and (2) the +2-deep build preloads enough that selecting a visible node never
// triggers a fresh fetch.

// In-memory project: each file 'uses' the listed files (its dependencies). Callers are
// the reverse of that relation, the same way the LSP reference provider would report.
type Project = Record<string, string[]>;

const id = (uri: string) => `${uri}:0`;
const node = (uri: string, role: NodeRole) =>
  ({ id: id(uri), name: uri, uri, line: 0, kind: 'class' as const, tags: [] as string[], role });

// A fake expander over `project` that records every fetched URI into `fetches`, so a
// test can assert exactly which files were resolved (and which were never touched).
function makeExpander(project: Project, fetches: string[]): ExpandClass {
  const callers: Record<string, string[]> = {};
  for (const [u, deps] of Object.entries(project)) {
    for (const d of deps) { (callers[d] ??= []).push(u); }
  }
  return async (uri, onStage) => {
    fetches.push(uri);
    onStage({ stage: 'center', node: node(uri, 'center') });
    const deps = project[uri] ?? [];
    if (deps.length) {
      onStage({
        stage: 'dependencies',
        nodes: deps.map(d => node(d, 'dependency')),
        edges: deps.map(d => ({ from: id(uri), to: id(d), kind: 'uses' as const })),
      });
    }
    const cs = callers[uri] ?? [];
    if (cs.length) {
      onStage({
        stage: 'callers',
        nodes: cs.map(c => node(c, 'caller')),
        edges: cs.map(c => ({ from: id(c), to: id(uri), kind: 'calls' as const })),
      });
    }
  };
}

//   A → B, C ;  B → D ;  C → D, E ;  D → F
//   hop 0: A (selected) | hop 1: B, C (active) | hop 2: D, E (inactive) | hop 3: F (shadow)
const PROJECT: Project = { A: ['B', 'C'], B: ['D'], C: ['D', 'E'], D: ['F'], E: [], F: [] };

test('loads the whole neighbourhood and classifies every node by hop distance', async () => {
  const fetches: string[] = [];
  const g = await buildTieredGraph({ centerUri: 'A', seqId: 1, expand: makeExpander(PROJECT, fetches) });

  const tierOf = (uri: string) => g.nodes.get(id(uri))?.tier;
  assert.equal(g.selectedId, id('A'));
  assert.equal(tierOf('A'), 'selected');
  assert.equal(tierOf('B'), 'active');
  assert.equal(tierOf('C'), 'active');
  assert.equal(tierOf('D'), 'inactive');
  assert.equal(tierOf('E'), 'inactive');
  assert.equal(tierOf('F'), 'shadow');
  assert.equal(g.nodes.size, 6);

  // Every relationship edge is present and directed correctly (A→B means A uses B).
  const has = (from: string, to: string) => g.edges.some(e => e.from === id(from) && e.to === id(to));
  assert.ok(has('A', 'B') && has('A', 'C'), 'active ring edges');
  assert.ok(has('B', 'D') && has('C', 'D') && has('C', 'E'), 'inactive ring edges');
  assert.ok(has('D', 'F'), 'shadow ring edge');
});

test('selecting an inactive node needs no extra fetch — its neighbourhood is preloaded', async () => {
  const fetches: string[] = [];
  const g = await buildTieredGraph({ centerUri: 'A', seqId: 1, expand: makeExpander(PROJECT, fetches) });

  // D is inactive (hop 2). The shadow pass already expanded it, so its full
  // neighbourhood is in the model — switching the selection to D draws from loaded
  // data instead of querying again.
  const D = g.nodes.get(id('D'))!;
  assert.equal(D.tier, 'inactive');
  assert.ok(D.expanded, 'an inactive node must already be expanded');

  // Its dependency (F) and its callers (B, C) are all present as nodes.
  for (const nbr of ['F', 'B', 'C']) {
    assert.ok(g.nodes.has(id(nbr)), `neighbour ${nbr} of D should be preloaded`);
  }

  // D was fetched exactly once across the whole build — no redundant or on-select fetch.
  assert.equal(fetches.filter(u => u === 'D').length, 1);

  // The shadow tier is the loaded frontier: F exists as a node (and its edge to D is
  // known) but it is never expanded, so it cost no fetch.
  assert.equal(g.nodes.get(id('F'))!.expanded, false);
  assert.ok(!fetches.includes('F'), 'shadow nodes must not be fetched');
});

test('each file is expanded at most once even when several rings reach it', async () => {
  // D is a dependency of both B and C; it must still be fetched a single time.
  const fetches: string[] = [];
  await buildTieredGraph({ centerUri: 'A', seqId: 1, expand: makeExpander(PROJECT, fetches) });

  const counts = fetches.reduce<Record<string, number>>((m, u) => ((m[u] = (m[u] ?? 0) + 1), m), {});
  assert.deepEqual(counts, { A: 1, B: 1, C: 1, D: 1, E: 1 });
});

test('every expanded node carries its true caller/dependency counts', async () => {
  const g = await buildTieredGraph({ centerUri: 'A', seqId: 1, expand: makeExpander(PROJECT, []) });
  const N = (u: string) => g.nodes.get(id(u))!;
  // [callers, deps] — the exact figures the status bar must show for each.
  assert.deepEqual([N('A').callers, N('A').deps], [0, 2]);   // selected
  assert.deepEqual([N('B').callers, N('B').deps], [1, 1]);   // active
  assert.deepEqual([N('C').callers, N('C').deps], [1, 2]);   // active
  assert.deepEqual([N('D').callers, N('D').deps], [2, 1]);   // inactive — the case that was wrong
  assert.deepEqual([N('E').callers, N('E').deps], [1, 0]);   // inactive
  // F is the shadow frontier: never expanded, so its count is unknown (-1) rather than
  // a misleading partial number.
  assert.equal(N('F').expanded, false);
  assert.deepEqual([N('F').callers, N('F').deps], [-1, -1]);
});

test('an inactive node is fully counted on select — its active ring was preloaded as shadow', async () => {
  // Build around A. D is inactive, yet — because the +2-deep build expanded it during
  // the shadow pass — its real counts and whole neighbourhood are already loaded.
  const g1 = await buildTieredGraph({ centerUri: 'A', seqId: 1, expand: makeExpander(PROJECT, []) });
  const D1 = g1.nodes.get(id('D'))!;
  assert.equal(D1.tier, 'inactive');
  assert.deepEqual([D1.callers, D1.deps], [2, 1]);                 // counted while still inactive
  for (const u of ['B', 'C', 'F']) {                              // its whole ring is on the canvas
    assert.ok(g1.nodes.has(id(u)), u + ' should be preloaded before selecting D');
  }

  // Now SELECT D (re-root the graph on it). It becomes selected, B/C/F become its active
  // ring, and the count is identical to what was already shown while it was inactive —
  // nothing new had to be discovered to make the counter correct.
  const g2 = await buildTieredGraph({ centerUri: 'D', seqId: 2, expand: makeExpander(PROJECT, []) });
  assert.equal(g2.selectedId, id('D'));
  assert.equal(g2.nodes.get(id('D'))!.tier, 'selected');
  assert.deepEqual([g2.nodes.get(id('D'))!.callers, g2.nodes.get(id('D'))!.deps], [2, 1]);
  for (const u of ['B', 'C', 'F']) {
    assert.equal(g2.nodes.get(id(u))!.tier, 'active', u + ' should be active once D is selected');
  }
});

test('an inactive node keeps its full shadow ring in the model — so it survives a rebuild', async () => {
  // This is the exact case behind "count says 5c·3d but the canvas shows fewer": the
  // webview reconciles to this model, so the inactive node's shadow neighbours must be
  // present and connected here, or they get pruned off the canvas on navigation.
  const g = await buildTieredGraph({ centerUri: 'A', seqId: 1, expand: makeExpander(PROJECT, []) });
  const D = g.nodes.get(id('D'))!;
  assert.equal(D.tier, 'inactive');
  assert.deepEqual([D.callers, D.deps], [2, 1]);   // the count the status bar shows

  // D's shadow ring (its dependency F) is present, classified shadow, and edge-linked —
  // every neighbour the count promises is in the reconcile set.
  const F = g.nodes.get(id('F'))!;
  assert.equal(F.tier, 'shadow');
  assert.ok(g.edges.some(e => e.from === id('D') && e.to === id('F')), 'D→F must be in the model');

  // The count equals the number of D's neighbours actually present in the model — no
  // phantom edges the canvas can't show.
  const present = g.edges.filter(e => e.from === id('D') || e.to === id('D'))
    .filter(e => g.nodes.has(e.from) && g.nodes.has(e.to));
  assert.equal(present.length, D.callers + D.deps);
});

test('emits authoritative counts for every expanded node, tagged with the build seqId', async () => {
  const msgs: { command: string; id?: string; callers?: number; deps?: number; seqId?: number }[] = [];
  await buildTieredGraph({ centerUri: 'A', seqId: 7, expand: makeExpander(PROJECT, []), emit: (m) => msgs.push(m) });
  const counts = msgs.filter(m => m.command === 'counts');
  const byId = new Map(counts.map(m => [m.id, m]));
  assert.deepEqual([byId.get(id('D'))!.callers, byId.get(id('D'))!.deps], [2, 1]);
  assert.deepEqual([byId.get(id('A'))!.callers, byId.get(id('A'))!.deps], [0, 2]);
  assert.ok(!byId.has(id('F')), 'the unexpanded shadow frontier gets no count message');
  assert.ok(counts.every(m => m.seqId === 7), 'every count rides the build seqId');
});

test('a stale build stops emitting and expanding once cancelled', async () => {
  const fetches: string[] = [];
  // Cancel immediately: the centre is fetched once, but no rings should follow and no
  // buildDone should be emitted.
  const messages: string[] = [];
  await buildTieredGraph({
    centerUri: 'A',
    seqId: 1,
    expand: makeExpander(PROJECT, fetches),
    emit: (m) => messages.push(m.command),
    isCancelled: () => true,
  });

  assert.ok(!messages.includes('buildDone'), 'cancelled build must not report completion');
  assert.ok(!fetches.includes('D'), 'cancelled build must not expand later rings');
});
