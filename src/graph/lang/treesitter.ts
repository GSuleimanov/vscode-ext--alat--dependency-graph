import * as path from 'path';
import Parser = require('web-tree-sitter');

export type SyntaxNode = Parser.SyntaxNode;

// web-tree-sitter needs a one-time async runtime init, then each grammar wasm is
// loaded once and cached. parse() itself is synchronous after that.
let runtime: Promise<void> | null = null;
function ensureRuntime(): Promise<void> {
  if (!runtime) { runtime = Parser.init(); }
  return runtime;
}

const languages = new Map<string, Parser.Language>();

/** Locate a prebuilt grammar wasm: from node_modules (dev/tests), else next to the bundle. */
function resolveGrammar(wasmFile: string): string {
  try {
    return require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
  } catch {
    return path.join(__dirname, wasmFile);
  }
}

export async function loadLanguage(id: string, wasmFile: string): Promise<void> {
  await ensureRuntime();
  if (languages.has(id)) { return; }
  languages.set(id, await Parser.Language.load(resolveGrammar(wasmFile)));
}

/** A parser bound to an already-loaded language. Throws if loadLanguage wasn't awaited. */
export function newParser(id: string): Parser {
  const lang = languages.get(id);
  if (!lang) { throw new Error(`tree-sitter language '${id}' not loaded — await loadLanguage first`); }
  const p = new Parser();
  p.setLanguage(lang);
  return p;
}

/** Compile a tree-sitter query against an already-loaded language. Compile once and reuse. */
export function compileQuery(id: string, source: string): Parser.Query {
  const lang = languages.get(id);
  if (!lang) { throw new Error(`tree-sitter language '${id}' not loaded — await loadLanguage first`); }
  return lang.query(source);
}

// -- small AST helpers shared by language providers --

/** Direct named child of a given type (not deep). */
export function childOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const c of node.namedChildren) {
    if (c.type === type) { return c; }
  }
  return null;
}

/** Reduce a type reference node (type_identifier / generic_type / scoped) to its simple name. */
export function simpleTypeName(node: SyntaxNode): string {
  if (node.type === 'generic_type') {
    const base = node.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'scoped_type_identifier');
    if (base) { return simpleTypeName(base); }
  }
  return (node.text.split('<')[0].split('.').pop() || node.text).trim();
}
