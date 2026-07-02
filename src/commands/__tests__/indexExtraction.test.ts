import { test, before } from 'node:test';
import assert from 'node:assert';
import { makeProvider } from '../../graph/lang/generic/provider';
import { goSpec, typescriptSpec } from '../../graph/lang/generic/specs';
import { pythonProvider } from '../../graph/lang/python/provider';
import {
  createProjectIndex, defsFromTypes, refsFromTypes, FileFacts,
} from '../../graph/data/projectIndex';
import { LanguageProvider } from '../../graph/lang/registry';

// End-to-end extraction tests: real tree-sitter parses feeding the reverse index,
// no VSCode and no LSP. These are the Section-2 acceptance cases — Python and Go
// neighbourhoods must resolve from the index alone (the LSP dependency on
// Pylance/gopls is exactly what broke both languages).

const go = makeProvider(goSpec);
const ts = makeProvider(typescriptSpec);
before(async () => { await Promise.all([go.init(), ts.init(), pythonProvider.init()]); });

function factsOf(provider: LanguageProvider, uri: string, src: string): FileFacts {
  const types = provider.parse(src, uri);
  const refs = provider.refNames ? provider.refNames(src, uri) : refsFromTypes(types);
  return { uri, defs: defsFromTypes(types, uri), refs };
}

// ── Python ──────────────────────────────────────────────────────────────────────

const PY_A = `class A:\n    pass\n`;
const PY_B = `from a import A\n\nclass B(A):\n    pass\n`;
const PY_MAIN = `from b import B\n\ndef run():\n    item = B()\n    return item\n`;

test('python: B lists A as dependency, A lists B as caller — via the index', () => {
  const bTypes = pythonProvider.parse(PY_B, 'file:///pkg/b.py');
  assert.deepEqual(bTypes[0].extendsNames, ['A'], 'B(A) base captured');

  const idx = createProjectIndex([
    factsOf(pythonProvider, 'file:///pkg/a.py', PY_A),
    factsOf(pythonProvider, 'file:///pkg/b.py', PY_B),
    factsOf(pythonProvider, 'file:///pkg/main.py', PY_MAIN),
  ]);
  assert.equal(idx.defsOf('A')[0]?.uri, 'file:///pkg/a.py');
  assert.deepEqual(idx.callerFilesOf('A'), ['file:///pkg/b.py'], 'subclassing counts as calling');
  assert.deepEqual(idx.callerFilesOf('B'), ['file:///pkg/main.py'], 'instantiation in module code counts');
});

test('python: refNames sees module-level instantiations the class parse misses', () => {
  const { refs } = factsOf(pythonProvider, 'file:///pkg/main.py', PY_MAIN);
  assert.ok(refs.includes('B'), 'B() inside a free function is a reference');
});

test('python: own definitions are not self-references', () => {
  const { refs } = factsOf(pythonProvider, 'file:///pkg/b.py', PY_B);
  assert.ok(!refs.includes('B'), 'defining B is not referencing B');
  assert.ok(refs.includes('A'), 'the base class is');
});

// ── Go ──────────────────────────────────────────────────────────────────────────

const GO_MODELS = `package models

type (
	Store struct{}
	Cache struct{}
)
`;
const GO_SERVER = `package svc

import "app/models"

type Server struct {
	store models.Store
}

func NewServer() *Server {
	s := &Server{store: models.Store{}}
	_ = models.Cache{}
	return s
}
`;

test('go: grouped type (…) blocks parse into defs', () => {
  const types = go.parse(GO_MODELS, 'file:///app/models/models.go');
  assert.deepEqual(types.map(t => t.name).sort(), ['Cache', 'Store']);
});

test('go: composite literals and signatures count as references', () => {
  const { refs } = factsOf(go, 'file:///app/svc/server.go', GO_SERVER);
  assert.ok(refs.includes('Store'), 'field type + composite literal');
  assert.ok(refs.includes('Cache'), 'bare composite literal in a function body');
  assert.ok(!refs.includes('Server'), 'own struct is not a self-reference');
});

test('go: the index yields callers across files', () => {
  const idx = createProjectIndex([
    factsOf(go, 'file:///app/models/models.go', GO_MODELS),
    factsOf(go, 'file:///app/svc/server.go', GO_SERVER),
  ]);
  assert.deepEqual(idx.callerFilesOf('Store'), ['file:///app/svc/server.go']);
  assert.deepEqual(idx.callerFilesOf('Cache'), ['file:///app/svc/server.go']);
  assert.deepEqual(idx.callerFilesOf('Server'), [], 'nobody uses Server yet');
});

// ── TypeScript (the query-driven refNames path) ────────────────────────────────

test('typescript: module-level usage outside any class still counts as a reference', () => {
  const src = `import { Engine } from './engine';
export function boot(cfg: Config): Engine { return new Engine(cfg); }
`;
  const refs = ts.refNames!(src, 'file:///app/boot.ts');
  assert.ok(refs.includes('Engine'), 'type in a free function signature');
  assert.ok(refs.includes('Config'), 'parameter type at module level');
});
