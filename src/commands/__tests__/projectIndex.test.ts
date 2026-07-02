import { test } from 'node:test';
import assert from 'node:assert';
import { createProjectIndex, IndexedDef, FileFacts } from '../../graph/data/projectIndex';

// Pure-index tests over a fake project — no VSCode, no tree-sitter. These pin the
// contract focusedGraphBuilder relies on: defsOf replaces the workspace-symbol
// lookup, callerFilesOf replaces the reference-provider scan, and an incremental
// upsert/remove leaves the maps exactly as a from-scratch build would.

const def = (name: string, uri: string, line = 0): IndexedDef =>
  ({ name, uri, line, kind: 'class' });

//   a.ts defines A and uses B ; b.ts defines B ; c.ts uses A and B
const PROJECT: FileFacts[] = [
  { uri: 'file:///a.ts', defs: [def('A', 'file:///a.ts', 3)], refs: ['B'] },
  { uri: 'file:///b.ts', defs: [def('B', 'file:///b.ts')], refs: [] },
  { uri: 'file:///c.ts', defs: [def('C', 'file:///c.ts')], refs: ['A', 'B'] },
];

test('defsOf resolves a simple name to its defining file', () => {
  const idx = createProjectIndex(PROJECT);
  assert.deepEqual(idx.defsOf('A'), [{ name: 'A', uri: 'file:///a.ts', line: 3, kind: 'class' }]);
  assert.deepEqual(idx.defsOf('Missing'), []);
});

test('callerFilesOf is the reverse lookup: every file that mentions the name', () => {
  const idx = createProjectIndex(PROJECT);
  assert.deepEqual(idx.callerFilesOf('B').sort(), ['file:///a.ts', 'file:///c.ts']);
  assert.deepEqual(idx.callerFilesOf('A'), ['file:///c.ts']);
  assert.deepEqual(idx.callerFilesOf('C'), []);
});

test('upsertFile replaces a file\'s contribution — stale refs and defs drop out', () => {
  const idx = createProjectIndex(PROJECT);
  // a.ts is edited: A renamed to A2, and it now uses C instead of B.
  idx.upsertFile('file:///a.ts', [def('A2', 'file:///a.ts')], ['C']);

  assert.deepEqual(idx.defsOf('A'), [], 'old def gone');
  assert.equal(idx.defsOf('A2').length, 1, 'new def present');
  assert.deepEqual(idx.callerFilesOf('B'), ['file:///c.ts'], 'a.ts no longer refs B');
  assert.deepEqual(idx.callerFilesOf('C'), ['file:///a.ts'], 'new ref indexed');
});

test('removeFile tears down defs and refs completely', () => {
  const idx = createProjectIndex(PROJECT);
  idx.removeFile('file:///c.ts');
  assert.deepEqual(idx.callerFilesOf('A'), []);
  assert.deepEqual(idx.callerFilesOf('B'), ['file:///a.ts']);
  assert.deepEqual(idx.defsOf('C'), []);
});

test('duplicate names across files: defsOf returns all, callerFilesOf dedupes per file', () => {
  const idx = createProjectIndex([
    { uri: 'file:///x.ts', defs: [def('Dup', 'file:///x.ts')], refs: [] },
    { uri: 'file:///y.ts', defs: [def('Dup', 'file:///y.ts')], refs: ['Dup', 'Dup'] },
  ]);
  assert.equal(idx.defsOf('Dup').length, 2);
  assert.deepEqual(idx.callerFilesOf('Dup'), ['file:///y.ts']);
});

test('ready flips only when marked — the readiness probe the host awaits', () => {
  const idx = createProjectIndex();
  assert.equal(idx.ready(), false);
  idx.markReady();
  assert.equal(idx.ready(), true);
});

test('stats reflect live contents', () => {
  const idx = createProjectIndex(PROJECT);
  assert.deepEqual(idx.stats(), { files: 3, symbols: 3, refs: 3 });
  idx.removeFile('file:///c.ts');
  assert.deepEqual(idx.stats(), { files: 2, symbols: 2, refs: 1 });
});

test('snapshot round-trips: rebuilding from it yields identical lookups', () => {
  const idx = createProjectIndex(PROJECT);
  idx.upsertFile('file:///d.go', [def('D', 'file:///d.go', 7)], ['A']);

  const restored = createProjectIndex(JSON.parse(JSON.stringify(idx.snapshot())));
  assert.deepEqual(restored.defsOf('D'), idx.defsOf('D'));
  assert.deepEqual(restored.callerFilesOf('A').sort(), idx.callerFilesOf('A').sort());
  assert.deepEqual(restored.stats(), idx.stats());
});
