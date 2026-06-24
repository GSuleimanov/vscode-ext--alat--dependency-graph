import { test, before } from 'node:test';
import assert from 'node:assert';
import { parseJavaSource, parsePythonSource, buildGraph, javaProvider, pythonProvider } from '../../graph';

before(async () => { await javaProvider.init(); await pythonProvider.init(); });

function tagsOf(types: ReturnType<typeof parseJavaSource>, name: string): string[] {
  return types.find(t => t.name === name)?.tags ?? [];
}

test('java: composable framework rules union (jakarta entity + lombok dto)', () => {
  const src = `
    package com.example;
    import jakarta.persistence.Entity;
    import lombok.Data;
    @Entity
    @Data
    public class Order {
      private Long id;
    }
  `;
  const tags = tagsOf(parseJavaSource(src, 'file:///Order.java'), 'Order');
  assert.ok(tags.includes('entity'), 'jakarta rule -> entity');
  assert.ok(tags.includes('dto'), 'lombok rule -> dto');
});

test('java: framework rules stay disabled without the import', () => {
  // @Service present but no springframework import -> spring rule gated off.
  const src = `
    package com.example;
    @Service
    public class OrderService {}
  `;
  const tags = tagsOf(parseJavaSource(src, 'file:///OrderService.java'), 'OrderService');
  assert.ok(!tags.includes('service'), 'spring rule must be gated by import');
});

test('java: spring stereotypes map to roles (incl. @Component as service)', () => {
  const src = `
    package com.example;
    import org.springframework.stereotype.Service;
    import org.springframework.stereotype.Component;
    import org.springframework.web.bind.annotation.RestController;
    @Service class Billing {}
    @Component class Clock {}
    @RestController class OrderApi {}
  `;
  const types = parseJavaSource(src, 'file:///x.java');
  assert.ok(tagsOf(types, 'Billing').includes('service'));
  assert.ok(tagsOf(types, 'Clock').includes('service'), '@Component -> service');
  assert.ok(tagsOf(types, 'OrderApi').includes('controller'));
});

test('java: classes with listener methods are tagged as event handlers', () => {
  const src = `
    package com.example;
    import org.springframework.context.event.EventListener;
    class OrderEvents {
      @EventListener
      public void onOrderPlaced(OrderPlaced e) {}
    }
    class KafkaConsumer {
      @KafkaListener(topics = "orders")
      void consume(String msg) {}
    }
    class Plain {
      public void doWork() {}
    }
  `;
  const types = parseJavaSource(src, 'file:///x.java');
  assert.ok(tagsOf(types, 'OrderEvents').includes('eventHandler'), '@EventListener -> eventHandler');
  assert.ok(tagsOf(types, 'KafkaConsumer').includes('eventHandler'), '@KafkaListener -> eventHandler');
  assert.ok(!tagsOf(types, 'Plain').includes('eventHandler'), 'no listener -> not an event handler');
});

test('java: abstract classes are tagged abstract; concrete are not', () => {
  const src = `
    package com.example;
    public abstract class BaseService {}
    public class ConcreteService {}
  `;
  const types = parseJavaSource(src, 'file:///x.java');
  assert.ok(tagsOf(types, 'BaseService').includes('abstract'), 'abstract class -> abstract tag');
  assert.ok(!tagsOf(types, 'ConcreteService').includes('abstract'), 'concrete class -> no abstract tag');
});

test('java: @Entity + @Data keeps both tags (graceful overlap)', () => {
  // An entity annotated @Data for convenience must retain BOTH roles so the view
  // can prefer "entity" without losing the dto signal.
  const src = `
    package com.example;
    import jakarta.persistence.Entity;
    import lombok.Data;
    @Entity @Data public class Customer { private Long id; }
  `;
  const tags = tagsOf(parseJavaSource(src, 'file:///Customer.java'), 'Customer');
  assert.ok(tags.includes('entity'), 'entity tag present');
  assert.ok(tags.includes('dto'), 'dto tag also present');
});

test('java: records and enums are tagged dto/enum', () => {
  const src = `
    package com.example;
    public record Money(Currency amount) {}
    public enum Status { A, B }
  `;
  const types = parseJavaSource(src, 'file:///x.java');
  assert.ok(tagsOf(types, 'Money').includes('dto'), 'record -> dto');
  assert.ok(tagsOf(types, 'Status').includes('enum'), 'enum -> enum');
  // record component type still produces a uses edge
  assert.ok(types.find(t => t.name === 'Money')?.fieldTypes.includes('Currency'));
});

test('cross-cutting test tag is applied by path', () => {
  const src = `package com.example; class OrderServiceTest {}`;
  const g = buildGraph(parseJavaSource(src, 'file:///src/test/java/com/example/OrderServiceTest.java'));
  const node = g.nodes.find(n => n.name === 'OrderServiceTest');
  assert.ok(node?.tags.includes('test'));
});

test('python: pydantic model and enum classified, base class -> extends edge', () => {
  const src = `
from pydantic import BaseModel
from enum import Enum

class Status(Enum):
    A = 1

class User(BaseModel):
    name: str
    status: Status
  `;
  const types = parsePythonSource(src, 'file:///app/models.py');
  const byName = Object.fromEntries(types.map(t => [t.name, t.tags ?? []]));
  assert.ok(byName.User.includes('dto'), 'pydantic BaseModel -> dto');
  assert.ok(byName.Status.includes('enum'), 'Enum subclass -> enum');

  const g = buildGraph(types);
  assert.ok(
    g.edges.some(e => e.from.endsWith('User') && e.to.endsWith('Status') && e.kind === 'uses'),
    'annotated attribute -> uses edge'
  );
});

test('python: pydantic rule gated on import', () => {
  const src = `
class User(BaseModel):
    name: str
  `;
  const types = parsePythonSource(src, 'file:///app/models.py');
  assert.ok(!(types[0].tags ?? []).includes('dto'), 'no pydantic import -> no dto');
});
