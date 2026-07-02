import { ParsedType, TypeKind } from '../../core/types';
import { LanguageProvider, RoleRule, FileContext, applyRules } from '../registry';
import { loadLanguage, compileQuery, newParser, simpleTypeName, SyntaxNode } from '../treesitter';
import Parser = require('web-tree-sitter');

/**
 * A query-driven language strategy. Everything grammar-specific lives in the
 * tree-sitter query (`query`) — the parsing code below is fully generic. Adding a
 * language is a spec object, not a new provider implementation.
 *
 * Capture vocabulary the query must use:
 *   @def.class / @def.interface / @def.enum  — on the type-declaration node; sets `kind`
 *   @name        — the declared simple name (a direct child of the declaration)
 *   @extends     — a supertype / base-class reference (becomes an `extends` edge)
 *   @implements  — an implemented-interface reference (becomes an `implements` edge)
 *   @uses        — a type reference in a member/field/param/return position (`uses` edge)
 *   @annotation  — a decorator / attribute name on the declaration (feeds role rules)
 *   @import      — an imported module path, for cross-package edge resolution (optional)
 *   @package     — a namespace/package name for the file (optional; else derived from the path)
 *
 * `@name` is captured in the same pattern as its `@def.*` (single-valued). All other
 * captures are matched by their own patterns and attributed to the enclosing
 * declaration by walking the AST, which keeps patterns simple and avoids the
 * combinatorial blow-up of binding many children inside one pattern.
 */
export interface LangSpec {
  id: string;                 // VSCode languageId, e.g. 'typescript'
  extensions: string[];       // e.g. ['.ts']
  wasmFile: string;           // prebuilt grammar in tree-sitter-wasms/out
  include: string;            // findFiles include glob
  exclude: string;            // findFiles exclude glob
  query: string;              // the tagging query (capture vocabulary above)
  builtins?: Set<string>;     // type names to drop from `uses` (language primitives/stdlib)
  rules?: RoleRule[];         // optional per-language "sugar" (Spring/React/...): role classifiers
  packageFromUri?: (uri: string) => string; // fallback package when the query yields no @package
}

const last = (s: string) => s.split('.').pop() ?? s;

/** Default package: last two path segments, so same-named types in different dirs stay distinct. */
function defaultPackage(uri: string): string {
  const p = uri.replace(/^[a-z]+:\/\//i, '').replace(/\\/g, '/');
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.slice(-2).join('.');
}

export function makeProvider(spec: LangSpec): LanguageProvider {
  let query: Parser.Query | null = null;

  function parse(text: string, uri: string): ParsedType[] {
    const root = newParser(spec.id).parse(text).rootNode;
    const matches = query!.matches(root);

    // Pass 1: every declaration node, keyed by its AST id, with its own name + kind.
    interface Decl {
      node: SyntaxNode; name: string; kind: TypeKind;
      extends: Set<string>; implements: Set<string>; uses: Set<string>; annotations: Set<string>;
    }
    const decls = new Map<number, Decl>();
    for (const m of matches) {
      const def = m.captures.find(c => c.name.startsWith('def.'));
      if (!def) { continue; }
      const name = m.captures.find(c => c.name === 'name')?.node.text;
      if (!name) { continue; }
      if (!decls.has(def.node.id)) {
        decls.set(def.node.id, {
          node: def.node, name, kind: def.name.slice('def.'.length) as TypeKind,
          extends: new Set(), implements: new Set(), uses: new Set(), annotations: new Set(),
        });
      }
    }
    const declIds = new Set(decls.keys());

    // Nearest enclosing declaration of a node. `viaSibling` also accepts a decl
    // that is a child of an ancestor (e.g. a TS decorator sits on the wrapping
    // `export_statement`, a sibling of the `class_declaration`).
    const enclosing = (node: SyntaxNode, viaSibling = false): Decl | undefined => {
      let n = node.parent;
      while (n) {
        if (declIds.has(n.id)) { return decls.get(n.id); }
        if (viaSibling) {
          for (const c of n.namedChildren) { if (declIds.has(c.id)) { return decls.get(c.id); } }
        }
        n = n.parent;
      }
      return undefined;
    };

    // Pass 2: attribute the multi-valued captures to their owning declaration.
    const imports = new Set<string>();
    let pkg = '';
    for (const m of matches) {
      for (const c of m.captures) {
        switch (c.name) {
          case 'import': imports.add(last2(c.node.text)); break;
          case 'package': if (!pkg) { pkg = c.node.text.trim(); } break;
          case 'extends': enclosing(c.node)?.extends.add(simpleTypeName(c.node)); break;
          case 'implements': enclosing(c.node)?.implements.add(simpleTypeName(c.node)); break;
          case 'uses': enclosing(c.node)?.uses.add(simpleTypeName(c.node)); break;
          case 'annotation': enclosing(c.node, true)?.annotations.add(last(c.node.text)); break;
        }
      }
    }
    if (!pkg) { pkg = spec.packageFromUri?.(uri) ?? defaultPackage(uri); }

    const results: ParsedType[] = [];
    for (const d of decls.values()) {
      const inherited = new Set([...d.extends, ...d.implements]);
      const fieldTypes = [...d.uses].filter(
        t => t !== d.name && !inherited.has(t) && !(spec.builtins?.has(t)),
      );
      results.push({
        name: d.name, package: pkg, uri, line: d.node.startPosition.row, kind: d.kind,
        extendsNames: [...d.extends], implementsNames: [...d.implements],
        fieldTypes, annotations: [...d.annotations], tags: [],
        imports: [...imports],
      });
    }

    const ctx: FileContext = { uri, text, imports, lang: spec.id };
    return applyRules(results, spec.rules ?? [], ctx);
  }

  // Whole-file type references for the reverse index. Deliberately does NOT
  // require an enclosing declaration (unlike parse()'s per-decl attribution), so
  // module-level code — free functions, top-level instantiations — still makes
  // this file a caller of the types it mentions. The file's own declared names
  // are dropped: a self-reference can't make a file its own caller, and the
  // declaration patterns double-capture their name node as a broad `uses`.
  function refNames(text: string, uri: string): string[] {
    const root = newParser(spec.id).parse(text).rootNode;
    const ownNames = new Set<string>();
    const refs = new Set<string>();
    for (const m of query!.matches(root)) {
      for (const c of m.captures) {
        if (c.name === 'name') { ownNames.add(c.node.text); }
        else if (c.name === 'uses' || c.name === 'extends' || c.name === 'implements') {
          refs.add(simpleTypeName(c.node));
        }
      }
    }
    return [...refs].filter(t => !ownNames.has(t) && !(spec.builtins?.has(t)));
  }

  return {
    id: spec.id,
    extensions: spec.extensions,
    include: spec.include,
    exclude: spec.exclude,
    init: async () => {
      await loadLanguage(spec.id, spec.wasmFile);
      query ??= compileQuery(spec.id, spec.query);
    },
    parse,
    refNames,
  };
}

/** Strip quotes/whitespace and keep the last dotted/slashed segment of an import path. */
function last2(raw: string): string {
  const cleaned = raw.replace(/['"`;]/g, '').trim();
  return cleaned.replace(/\\/g, '/').split('/').pop()?.split('.').pop() ?? cleaned;
}
