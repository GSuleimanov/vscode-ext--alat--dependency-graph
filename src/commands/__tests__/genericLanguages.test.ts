import { test, before } from 'node:test';
import assert from 'node:assert';
import { buildGraph } from '../../graph';
import { makeProvider, LangSpec } from '../../graph/lang/generic/provider';
import {
  typescriptSpec, javascriptSpec, goSpec, csharpSpec, cppSpec, cSpec,
} from '../../graph/lang/generic/specs';
import { RoleRule } from '../../graph/lang/registry';

// Build a provider once per spec and parse a source string with it.
async function parseWith(spec: LangSpec, uri: string, src: string) {
  const provider = makeProvider(spec);
  await provider.init();
  return provider.parse(src, uri);
}

const ts = makeProvider(typescriptSpec);
const go = makeProvider(goSpec);
const cs = makeProvider(csharpSpec);
const cpp = makeProvider(cppSpec);
before(async () => { await Promise.all([ts.init(), go.init(), cs.init(), cpp.init()]); });

test('typescript: class/interface/enum kinds, extends, implements, uses', () => {
  const types = ts.parse(`
    export class Bar extends Base implements Iface { private dep: Dep; }
    export class Base {}
    export interface Iface {}
    export class Dep {}
  `, 'file:///app/svc/bar.ts');
  const bar = types.find(t => t.name === 'Bar')!;
  assert.equal(bar.kind, 'class');
  assert.deepEqual(bar.extendsNames, ['Base']);
  assert.deepEqual(bar.implementsNames, ['Iface']);
  assert.ok(bar.fieldTypes.includes('Dep'), 'field type captured as a use');

  const g = buildGraph(types);
  const kinds = g.edges.filter(e => e.from === 'app.svc.Bar').map(e => `${e.kind}:${e.to.split('.').pop()}`).sort();
  assert.deepEqual(kinds, ['extends:Base', 'implements:Iface', 'uses:Dep']);
});

test('typescript: builtins are not emitted as uses', () => {
  const [c] = ts.parse(`export class C { items: Array<number>; when: Date; }`, 'file:///app/c.ts');
  assert.deepEqual(c.fieldTypes, [], 'Array/number/Date are builtins, not edges');
});

test('typescript: decorator feeds the role-rule (sugar) pipeline', async () => {
  const reactRule: RoleRule = {
    id: 'ts/react',
    enabled: () => true,
    tags: (type) => (type.annotations?.includes('Component') ? ['controller'] : []),
  };
  const spec: LangSpec = { ...typescriptSpec, rules: [reactRule] };
  const [widget] = await parseWith(spec, 'file:///app/w.ts',
    `@Component({}) export class Widget {}`);
  assert.ok(widget.annotations?.includes('Component'), 'decorator name captured');
  assert.ok(widget.tags?.includes('controller'), 'role rule applied the tag');
});

test('go: struct→class, interface, and field-type uses', () => {
  const types = go.parse(`
    package svc
    type Server struct { store Store; cache *Cache }
    type Store struct {}
    type Cache struct {}
    type Handler interface {}
  `, 'file:///app/svc/server.go');
  const server = types.find(t => t.name === 'Server')!;
  assert.equal(server.kind, 'class');
  assert.equal(server.package, 'svc', 'package comes from the package clause');
  assert.ok(types.find(t => t.name === 'Handler')!.kind === 'interface');

  const g = buildGraph(types);
  const uses = g.edges.filter(e => e.kind === 'uses').map(e => e.to.split('.').pop()).sort();
  assert.deepEqual(uses, ['Cache', 'Store'], 'plain and pointer field types both resolve');
});

test('csharp: bases become edges, namespace is the package, attribute is captured', () => {
  const types = cs.parse(`
    namespace App.Svc {
      [ApiController]
      public class UserService : BaseService, IUserService { private Repo repo; }
      public class BaseService {}
      public interface IUserService {}
      public class Repo {}
    }
  `, 'file:///App/UserService.cs');
  const svc = types.find(t => t.name === 'UserService')!;
  assert.equal(svc.package, 'App.Svc');
  assert.ok(svc.annotations?.includes('ApiController'));
  assert.ok(svc.extendsNames.includes('BaseService') && svc.extendsNames.includes('IUserService'));

  const g = buildGraph(types);
  const tos = g.edges.filter(e => e.from === 'App.Svc.UserService').map(e => e.to.split('.').pop()).sort();
  assert.deepEqual(tos, ['BaseService', 'IUserService', 'Repo']);
});

test('cpp: class/struct/enum kinds and base-class edges', () => {
  const types = cpp.parse(`
    class Server : public Base { Dep dep; };
    class Base {};
    struct Dep {};
    enum Color { Red, Green };
  `, 'file:///app/server.cpp');
  assert.equal(types.find(t => t.name === 'Server')!.kind, 'class');
  assert.equal(types.find(t => t.name === 'Dep')!.kind, 'class', 'struct maps to class kind');
  assert.equal(types.find(t => t.name === 'Color')!.kind, 'enum');

  const g = buildGraph(types);
  assert.ok(g.edges.some(e => e.kind === 'extends' && e.to.endsWith('Base')));
  assert.ok(g.edges.some(e => e.kind === 'uses' && e.to.endsWith('Dep')));
});

test('c: a struct definition is parsed, a struct-typed field is a use (not a duplicate def)', async () => {
  const types = await parseWith(cSpec, 'file:///app/server.c', `
    struct Server { struct Foo foo; int count; };
    struct Foo { int x; };
  `);
  const names = types.map(t => t.name).sort();
  assert.deepEqual(names, ['Foo', 'Server'], 'bare struct reference does not create a phantom type');
  const g = buildGraph(types);
  assert.ok(g.edges.some(e => e.from.endsWith('Server') && e.kind === 'uses' && e.to.endsWith('Foo')));
});

test('javascript: extends + new-expression dependencies', async () => {
  const types = await parseWith(javascriptSpec, 'file:///app/bar.js', `
    export class Bar extends Base { constructor() { super(); this.x = new Dep(); } }
    export class Base {}
    export class Dep {}
  `);
  const bar = types.find(t => t.name === 'Bar')!;
  assert.deepEqual(bar.extendsNames, ['Base']);
  assert.ok(bar.fieldTypes.includes('Dep'), 'new Dep() is a dependency');
  const g = buildGraph(types);
  assert.ok(g.edges.some(e => e.kind === 'extends' && e.to.endsWith('Base')));
  assert.ok(g.edges.some(e => e.kind === 'uses' && e.to.endsWith('Dep')));
});
