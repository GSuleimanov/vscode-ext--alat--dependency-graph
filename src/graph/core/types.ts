// Language-agnostic graph + parse model. No VSCode imports so it stays unit-testable.

export type TypeKind = 'class' | 'interface' | 'enum';
export type EdgeKind = 'extends' | 'implements' | 'uses';

// Multi-label role tag. Open-ended string so framework rules can contribute new
// roles without touching core; well-known values live in tags.ts.
export type Tag = string;

export interface GraphNode {
  id: string;        // fully-qualified name, e.g. com.example.OrderService
  name: string;      // simple name, e.g. OrderService
  package: string;   // e.g. com.example
  uri: string;       // source file uri (string form)
  line: number;      // 0-based line of the type declaration
  kind: TypeKind;    // class | interface | enum (structural)
  tags: Tag[];       // roles: dto, entity, repository, service, controller, test…
}

export interface GraphEdge {
  from: string;      // FQN of source class
  to: string;        // FQN of target class
  kind: EdgeKind;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// One parsed type declaration, language-agnostic, before cross-file resolution.
// `tags` / `annotations` are optional so callers (and tests) can build the
// structural shape and let role rules fill the rest.
export interface ParsedType {
  name: string;
  package: string;
  uri: string;
  line: number;
  kind: TypeKind;
  extendsNames: string[];    // simple names referenced in `extends` (Python: base classes)
  implementsNames: string[]; // simple names referenced in `implements`
  fieldTypes: string[];      // simple type names used in field/param/return positions
  annotations?: string[];    // simple annotation / decorator names on the declaration
  memberAnnotations?: string[]; // annotation names on members (methods/fields) within the type
  tags?: Tag[];              // roles contributed by language/framework rules
  imports?: string[];        // fully-qualified imports in scope, for import-aware edge resolution
}
