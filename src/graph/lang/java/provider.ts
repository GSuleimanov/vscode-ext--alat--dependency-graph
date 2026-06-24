import { ParsedType, TypeKind } from '../../core/types';
import { Tags } from '../../core/tags';
import { LanguageProvider, FileContext, applyRules } from '../registry';
import { javaRules } from './rules';
import { loadLanguage, newParser, childOfType, simpleTypeName, SyntaxNode } from '../treesitter';

const BUILTIN_TYPES = new Set([
  'String', 'Object', 'Integer', 'Long', 'Short', 'Byte', 'Boolean', 'Character',
  'Float', 'Double', 'List', 'Map', 'Set', 'Collection', 'Optional', 'Void',
  'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'Iterable',
]);

const TYPE_DECLS: Record<string, TypeKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'class',
};

function lastSegment(text: string): string {
  return text.split('.').pop() || text;
}

/** Simple annotation names on a declaration (from its direct `modifiers` child). */
function annotationsOf(decl: SyntaxNode): string[] {
  const modifiers = childOfType(decl, 'modifiers');
  if (!modifiers) { return []; }
  const out: string[] = [];
  for (const child of modifiers.namedChildren) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const name = child.childForFieldName('name');
      if (name) { out.push(lastSegment(name.text)); }
    }
  }
  return out;
}

/**
 * Visit every descendant of `decl` that belongs to `decl` itself, NOT descending
 * into nested type declarations. This attributes members/usages to the right
 * owner so an inner class's @EventListener or type references don't leak onto the
 * enclosing class (each nested type is parsed as its own node separately).
 */
function eachOwnDescendant(decl: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  const walk = (node: SyntaxNode) => {
    for (const child of node.namedChildren) {
      if (TYPE_DECLS[child.type]) { continue; }   // boundary: a nested type owns its own subtree
      fn(child);
      walk(child);
    }
  };
  walk(decl);
}

/** Annotation simple names on members (methods) within a type — e.g. @EventListener. */
function memberAnnotationsOf(decl: SyntaxNode): string[] {
  const out = new Set<string>();
  eachOwnDescendant(decl, (node) => {
    if (node.type !== 'method_declaration') { return; }
    const modifiers = childOfType(node, 'modifiers');
    if (!modifiers) { return; }
    for (const child of modifiers.namedChildren) {
      if (child.type === 'marker_annotation' || child.type === 'annotation') {
        const name = child.childForFieldName('name');
        if (name) { out.add(lastSegment(name.text)); }
      }
    }
  });
  return [...out];
}

/** Names in a `type_list` (used by extends-interfaces / super-interfaces). */
function typeListNames(container: SyntaxNode | null): string[] {
  if (!container) { return []; }
  const list = childOfType(container, 'type_list') ?? container;
  return list.namedChildren
    .filter(c => c.type !== 'type_list')
    .map(simpleTypeName);
}

export function parseJavaSource(rawSource: string, uri: string): ParsedType[] {
  const tree = newParser('java').parse(rawSource);
  const root = tree.rootNode;

  const pkgNode = childOfType(root, 'package_declaration');
  const pkg = pkgNode ? lastSegmentPath(pkgNode.text) : '';

  const imports = new Set<string>();
  for (const imp of root.namedChildren.filter(c => c.type === 'import_declaration')) {
    const path = imp.text.replace(/^\s*import\s+(?:static\s+)?/, '').replace(/\s*;\s*$/, '').trim();
    if (path) { imports.add(path); }
  }
  const importList = [...imports];

  const results: ParsedType[] = [];

  // Walk all type declarations, descending into bodies so nested/inner types are
  // parsed too. A nested type's name is qualified by its encloser (Outer.Inner)
  // so it gets a distinct FQN, while edge resolution still works on simple names.
  const visit = (node: SyntaxNode, enclosing: string): void => {
    for (const child of node.namedChildren) {
      const kind = TYPE_DECLS[child.type];
      if (!kind) { visit(child, enclosing); continue; }   // descend (class bodies, etc.)
      const simple = child.childForFieldName('name')?.text;
      if (!simple) { visit(child, enclosing); continue; }
      const name = enclosing ? `${enclosing}.${simple}` : simple;

      const extendsNames =
        child.type === 'interface_declaration'
          ? typeListNames(childOfType(child, 'extends_interfaces'))
          : namesOf(childOfType(child, 'superclass'));
      const implementsNames = typeListNames(childOfType(child, 'super_interfaces'));

      // Seed structural tags the rules can't infer from annotations alone.
      const seedTags: string[] = [];
      if (child.type === 'record_declaration') { seedTags.push(Tags.Dto); }
      const modifiers = childOfType(child, 'modifiers');
      if (modifiers && /\babstract\b/.test(modifiers.text)) { seedTags.push(Tags.Abstract); }

      results.push({
        name,
        package: pkg,
        uri,
        line: child.startPosition.row,
        kind,
        extendsNames,
        implementsNames,
        fieldTypes: usedTypes(child, simple, new Set([...extendsNames, ...implementsNames])),
        annotations: annotationsOf(child),
        memberAnnotations: memberAnnotationsOf(child),
        tags: seedTags,
        imports: importList,
      });

      visit(child, name);   // recurse for this type's own nested declarations
    }
  };
  visit(root, '');

  const ctx: FileContext = { uri, text: rawSource, imports, lang: 'java' };
  return applyRules(results, javaRules, ctx);
}

/** Type names directly under a node (e.g. a `superclass` wrapper). */
function namesOf(container: SyntaxNode | null): string[] {
  if (!container) { return []; }
  return container.namedChildren
    .filter(c => c.type.endsWith('type') || c.type.endsWith('type_identifier'))
    .map(simpleTypeName);
}

/** Collect a class declaration's `uses` type names, minus its inheritance names. */
function usedTypes(decl: SyntaxNode, ownName: string, inherited: Set<string>): string[] {
  const types = new Set<string>();

  eachOwnDescendant(decl, (node) => {
    if (node.type === 'type_identifier') {
      types.add(node.text);
    } else if (node.type === 'method_reference') {
      // Method references like `App::run` carry the type as a plain identifier.
      const first = node.namedChild(0);
      if (first && /^[A-Z][A-Za-z0-9_]*$/.test(first.text)) { types.add(first.text); }
    }
  });

  const out: string[] = [];
  for (const t of types) {
    if (t === ownName || inherited.has(t)) { continue; }
    if (BUILTIN_TYPES.has(t)) { continue; }
    if (/^[A-Z][A-Za-z0-9_]*$/.test(t)) { out.push(t); }
  }
  return out;
}

/** Final dotted segment of a `package x.y.z;` declaration's text. */
function lastSegmentPath(declText: string): string {
  const m = declText.match(/package\s+([\w.]+)/);
  return m ? m[1] : '';
}

export const javaProvider: LanguageProvider = {
  id: 'java',
  extensions: ['.java'],
  // Only real Java source roots (Maven/Gradle layout) — skips snippet .java
  // under tooling dirs like .claude, docs, etc.
  include: '**/src/{main,test,it,integration-test,testFixtures}/**/*.java',
  exclude: '**/{node_modules,target,build,bin,out}/**',
  init: () => loadLanguage('java', 'tree-sitter-java.wasm'),
  parse: parseJavaSource,
};
