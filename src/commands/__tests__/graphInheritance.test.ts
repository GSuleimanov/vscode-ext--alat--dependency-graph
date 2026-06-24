import { test, before } from 'node:test';
import assert from 'node:assert';
import { parseJavaSource, buildGraph, javaProvider } from '../../graph';

before(async () => { await javaProvider.init(); });

test('java: nested interfaces and abstract classes are parsed as their own types', () => {
  const types = parseJavaSource(`
    package app;
    public class Outer {
      public interface Listener {}
      abstract static class Base {}
    }
  `, 'file:///src/main/java/app/Outer.java');
  const names = types.map(t => t.name);
  assert.ok(names.includes('Outer'), 'outer parsed');
  assert.ok(names.includes('Outer.Listener'), 'nested interface parsed with qualified name');
  assert.ok(names.includes('Outer.Base'), 'nested abstract class parsed');

  const listener = types.find(t => t.name === 'Outer.Listener');
  assert.equal(listener?.kind, 'interface', 'nested interface keeps interface kind');
  const base = types.find(t => t.name === 'Outer.Base');
  assert.ok(base?.tags?.includes('abstract'), 'nested abstract class is tagged abstract');
});

test("java: a nested type's listener method does not tag the enclosing class", () => {
  const types = parseJavaSource(`
    package app;
    import org.springframework.context.event.EventListener;
    class Outer {
      void plain() {}
      static class Inner {
        @EventListener void onEvt(Object e) {}
      }
    }
  `, 'file:///src/main/java/app/Outer.java');
  const outer = types.find(t => t.name === 'Outer');
  const inner = types.find(t => t.name === 'Outer.Inner');
  assert.ok(!outer?.tags?.includes('eventHandler'), 'outer not tagged from nested method');
  assert.ok(inner?.tags?.includes('eventHandler'), 'inner is the event handler');
});

test('java: an interface extending multiple interfaces yields multiple extends edges', () => {
  const types = parseJavaSource(`
    package app;
    interface A {}
    interface B {}
    interface C extends A, B {}
  `, 'file:///src/main/java/app/x.java');
  const g = buildGraph(types);
  const ext = g.edges
    .filter(e => e.from === 'app.C' && e.kind === 'extends')
    .map(e => e.to)
    .sort();
  assert.deepEqual(ext, ['app.A', 'app.B'], 'both interface parents become extends edges');
});

test('java: edges resolve to the imported type, not a same-named one in another package', () => {
  const model = parseJavaSource(
    `package app.model; public class User {}`,
    'file:///src/main/java/app/model/User.java'
  );
  const dto = parseJavaSource(
    `package app.dto; public class User {}`,
    'file:///src/main/java/app/dto/User.java'
  );
  const svc = parseJavaSource(`
    package app.svc;
    import app.dto.User;
    public class UserService { private User user; }
  `, 'file:///src/main/java/app/svc/UserService.java');

  const g = buildGraph([...model, ...dto, ...svc]);
  const edge = g.edges.find(e => e.from === 'app.svc.UserService' && e.kind === 'uses');
  assert.equal(edge?.to, 'app.dto.User', 'uses edge follows the explicit import');
});

test('java: abstract base with multiple subclasses produces an extends edge per subclass', () => {
  const types = parseJavaSource(`
    package app;
    abstract class Shape {}
    class Circle extends Shape {}
    class Square extends Shape {}
  `, 'file:///src/main/java/app/shapes.java');
  const g = buildGraph(types);
  const toShape = g.edges
    .filter(e => e.to === 'app.Shape' && e.kind === 'extends')
    .map(e => e.from)
    .sort();
  assert.deepEqual(toShape, ['app.Circle', 'app.Square']);
});
