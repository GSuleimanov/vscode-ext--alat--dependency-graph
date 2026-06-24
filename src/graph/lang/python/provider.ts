import { ParsedType } from '../../core/types';
import { LanguageProvider, FileContext, applyRules } from '../registry';
import { pythonRules } from './rules';
import { loadLanguage, newParser, childOfType, SyntaxNode } from '../treesitter';

/** Derive a dotted package from the last couple of path segments. */
function packageFromUri(uri: string): string {
  const path = uri.replace(/^[a-z]+:\/\//i, '').replace(/\\/g, '/');
  const parts = path.split('/');
  parts.pop(); // drop filename
  return parts.slice(-2).join('.');
}

function lastIdentifier(node: SyntaxNode): string {
  const ids = node.descendantsOfType('identifier');
  return ids.length ? ids[ids.length - 1].text : node.text;
}

/** Base class simple names from a `class_definition` superclasses list. */
function baseNames(classDef: SyntaxNode): string[] {
  const supers = childOfType(classDef, 'argument_list');
  if (!supers) { return []; }
  const out: string[] = [];
  for (const arg of supers.namedChildren) {
    let name = '';
    if (arg.type === 'identifier') { name = arg.text; }
    else if (arg.type === 'attribute') { name = lastIdentifier(arg); } // enum.Enum -> Enum
    else { continue; } // keyword args (metaclass=…), calls, etc.
    if (/^[A-Z][A-Za-z0-9_]*$/.test(name) && name !== 'object') { out.push(name); }
  }
  return out;
}

/** Capitalized type names referenced in annotated class attributes (`x: Type`). */
function fieldTypes(classDef: SyntaxNode): string[] {
  const body = classDef.childForFieldName('body');
  if (!body) { return []; }
  const types = new Set<string>();
  for (const assign of body.descendantsOfType('assignment')) {
    const typeNode = assign.childForFieldName('type');
    if (!typeNode) { continue; }
    for (const id of typeNode.descendantsOfType('identifier')) {
      if (/^[A-Z][A-Za-z0-9_]*$/.test(id.text)) { types.add(id.text); }
    }
  }
  return [...types];
}

export function parsePythonSource(rawSource: string, uri: string): ParsedType[] {
  const root = newParser('python').parse(rawSource).rootNode;
  const pkg = packageFromUri(uri);

  const imports = new Set<string>();
  for (const imp of root.descendantsOfType(['import_from_statement', 'import_statement'])) {
    const mod = imp.childForFieldName('module_name') ?? imp.childForFieldName('name');
    if (mod) { imports.add(mod.text.split(' ')[0].trim()); }
  }

  const results: ParsedType[] = [];
  for (const node of root.namedChildren) {
    let classDef: SyntaxNode | null = null;
    let decorators: string[] = [];
    if (node.type === 'class_definition') {
      classDef = node;
    } else if (node.type === 'decorated_definition') {
      const def = node.childForFieldName('definition');
      if (def?.type === 'class_definition') {
        classDef = def;
        decorators = node.namedChildren
          .filter(c => c.type === 'decorator')
          .map(lastIdentifier);
      }
    }
    if (!classDef) { continue; }

    const name = classDef.childForFieldName('name')?.text;
    if (!name) { continue; }

    results.push({
      name,
      package: pkg,
      uri,
      line: classDef.startPosition.row,
      kind: 'class',
      extendsNames: baseNames(classDef),
      implementsNames: [],
      fieldTypes: fieldTypes(classDef),
      annotations: decorators,
      tags: [],
    });
  }

  const ctx: FileContext = { uri, text: rawSource, imports, lang: 'python' };
  return applyRules(results, pythonRules, ctx);
}

export const pythonProvider: LanguageProvider = {
  id: 'python',
  extensions: ['.py'],
  include: '**/*.py',
  exclude: '**/{node_modules,.venv,venv,__pycache__,build,dist,.git,site-packages}/**',
  init: () => loadLanguage('python', 'tree-sitter-python.wasm'),
  parse: parsePythonSource,
};
