import { test, before } from 'node:test';
import assert from 'node:assert';
import { parseJavaSource, buildGraph, ParsedType, javaProvider } from '../../graph';

before(async () => { await javaProvider.init(); });

function parse(src: string, uri = 'file:///T.java') {
  return parseJavaSource(src, uri);
}

test('parses package, class name and extends/implements', () => {
  const src = `
    package com.example.orders;
    public class OrderService extends BaseService implements Auditable, Closeable {
    }
  `;
  const [c] = parse(src);
  assert.equal(c.name, 'OrderService');
  assert.equal(c.package, 'com.example.orders');
  assert.deepEqual(c.extendsNames, ['BaseService']);
  assert.deepEqual(c.implementsNames.sort(), ['Auditable', 'Closeable']);
});

test('extracts field types, ignoring primitives and builtins', () => {
  const src = `
    package com.example;
    class OrderService {
      private PaymentGateway gateway;
      private int count;
      private String name;
      private final OrderRepository repo = null;
    }
  `;
  const [c] = parse(src);
  assert.deepEqual(c.fieldTypes.sort(), ['OrderRepository', 'PaymentGateway']);
});

test('captures Spring constructor-injected dependencies as uses edges', () => {
  const src = `
    package com.example;
    class OrderService {
      private final PaymentGateway gateway;
      public OrderService(PaymentGateway gateway, OrderRepository repo) {
        this.gateway = gateway;
      }
    }
    class PaymentGateway {}
    class OrderRepository {}
  `;
  const g = buildGraph(parse(src));
  const targets = g.edges.filter(e => e.from === 'com.example.OrderService' && e.kind === 'uses').map(e => e.to).sort();
  assert.deepEqual(targets, ['com.example.OrderRepository', 'com.example.PaymentGateway']);
});

test('captures @Autowired setter-injected dependencies', () => {
  const src = `
    package com.example;
    class ReportService {
      @Autowired
      public void setExporter(Exporter exporter) {}
    }
    class Exporter {}
  `;
  const g = buildGraph(parse(src));
  assert.ok(g.edges.some(e => e.from === 'com.example.ReportService' && e.to === 'com.example.Exporter' && e.kind === 'uses'));
});

test('links types used in generic args, method return types, and method params', () => {
  const src = `
    package com.example;
    interface VenueRepository extends JpaRepository<Venue, Long> {}
    class VenueController {
      public ResponseEntity<Venue> create(@RequestBody VenueCreateRequest request) { return null; }
      public ResponseEntity<List<Venue>> list() { return null; }
    }
    class VenueService {
      public Venue getById(Long id) { return null; }
    }
    class Venue {}
    class VenueCreateRequest {}
    class JpaRepository<T, ID> {}
    class ResponseEntity<T> {}
  `;
  const g = buildGraph(parse(src));
  // VenueRepository → Venue via JpaRepository<Venue, Long> generic arg
  assert.ok(g.edges.some(e => e.from === 'com.example.VenueRepository' && e.to === 'com.example.Venue' && e.kind === 'uses'),
    'VenueRepository should use Venue (via generic arg)');
  // VenueController → Venue via ResponseEntity<Venue> return type
  assert.ok(g.edges.some(e => e.from === 'com.example.VenueController' && e.to === 'com.example.Venue' && e.kind === 'uses'),
    'VenueController should use Venue (via return type generic)');
  // VenueController → VenueCreateRequest via method param
  assert.ok(g.edges.some(e => e.from === 'com.example.VenueController' && e.to === 'com.example.VenueCreateRequest' && e.kind === 'uses'),
    'VenueController should use VenueCreateRequest (via method param)');
  // VenueService → Venue via return type
  assert.ok(g.edges.some(e => e.from === 'com.example.VenueService' && e.to === 'com.example.Venue' && e.kind === 'uses'),
    'VenueService should use Venue (via return type)');
});

test('links classes referenced via method references (ClassName::method)', () => {
  const src = `
    package com.example;
    class TestGomatchApplication {
      public static void main(String[] args) {
        SpringApplication.from(GomatchApplication::run).run(args);
      }
    }
    class GomatchApplication {}
  `;
  const g = buildGraph(parse(src));
  assert.ok(
    g.edges.some(e => e.from === 'com.example.TestGomatchApplication' && e.to === 'com.example.GomatchApplication' && e.kind === 'uses'),
    'TestGomatchApplication should use GomatchApplication via method reference'
  );
});

test('links classes referenced as .class literals in annotations', () => {
  const src = `
    package com.example;
    @SpringBootTest(classes = GomatchApplication.class)
    @Import({TestContainersConfig.class})
    class GomatchApplicationTests {}
    class GomatchApplication {}
    class TestContainersConfig {}
  `;
  const g = buildGraph(parse(src));
  const targets = g.edges
    .filter(e => e.from === 'com.example.GomatchApplicationTests' && e.kind === 'uses')
    .map(e => e.to).sort();
  assert.deepEqual(targets, ['com.example.GomatchApplication', 'com.example.TestContainersConfig']);
});

test('records declaration kind (class/interface/enum)', () => {
  const src = `
    package p;
    public interface Repo {}
    enum Status { A, B }
    class Service {}
  `;
  const g = buildGraph(parse(src));
  const byName = Object.fromEntries(g.nodes.map(n => [n.name, n.kind]));
  assert.equal(byName.Repo, 'interface');
  assert.equal(byName.Status, 'enum');
  assert.equal(byName.Service, 'class');
});

test('buildGraph dedupes nodes by FQN', () => {
  const parsed: ParsedType[] = [
    { name: 'A', package: 'p', uri: 'u1', line: 0, kind: 'class', extendsNames: [], implementsNames: [], fieldTypes: [] },
    { name: 'A', package: 'p', uri: 'u1', line: 0, kind: 'class', extendsNames: [], implementsNames: [], fieldTypes: [] },
  ];
  const g = buildGraph(parsed);
  assert.equal(g.nodes.length, 1);
});

test('edges only connect classes that exist in the project', () => {
  const src = `
    package com.example;
    class OrderService {
      private PaymentGateway gw;
      private ExternalLib lib;
    }
    class PaymentGateway {}
  `;
  const g = buildGraph(parse(src));
  const uses = g.edges.filter(e => e.kind === 'uses');
  assert.equal(uses.length, 1);
  assert.equal(uses[0].to, 'com.example.PaymentGateway');
  // ExternalLib is not a project class -> no edge
  assert.ok(!g.edges.some(e => e.to.endsWith('ExternalLib')));
});

test('inheritance edges resolve and dedupe', () => {
  const src = `
    package p;
    class Base {}
    class Mid extends Base {}
    class Leaf extends Mid {}
  `;
  const g = buildGraph(parse(src));
  const ext = g.edges.filter(e => e.kind === 'extends').map(e => e.from + '->' + e.to).sort();
  assert.deepEqual(ext, ['p.Leaf->p.Mid', 'p.Mid->p.Base']);
});

test('resolution prefers same package on simple-name collision', () => {
  const src1 = `package a;
    class Repo {}`;
  const src2 = `package b;
    class Repo {}
    class User {
      private Repo repo;
    }`;
  const parsed = [...parse(src1, 'u1'), ...parse(src2, 'u2')];
  const g = buildGraph(parsed);
  const uses = g.edges.find(e => e.kind === 'uses' && e.from === 'b.User');
  assert.equal(uses?.to, 'b.Repo');
});
