import * as vscode from 'vscode';

export function getConfig() {
  return vscode.workspace.getConfiguration('codenav');
}

// Java reserved words plus contextual keywords (var, record, sealed, yield, …). Peeking
// one of these is never a meaningful navigation — there is no symbol to find — and the
// LSP may resolve `this`/`super`/`new` to a whole type, triggering a huge search. We
// short-circuit before any provider call.
const JAVA_KEYWORDS = new Set<string>([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while',
  // contextual / restricted keywords and literals
  'var', 'yield', 'record', 'sealed', 'permits', 'non-sealed', 'true', 'false', 'null',
]);

/** True when the word is a Java keyword/modifier/literal — not a navigable symbol. */
export function isJavaKeyword(word: string): boolean {
  return JAVA_KEYWORDS.has(word);
}

export function isTestLocation(loc: vscode.Location): boolean {
  const fsPath = loc.uri.fsPath;
  const cfg = getConfig();
  const testRoots: string[] = cfg.get('testSourceRoots') ?? ['src/test/', 'src/it/'];
  const testSuffixes: string[] = cfg.get('testFilePatterns') ?? ['Test.java', 'Tests.java', 'TestCase.java'];

  if (testRoots.some(root => fsPath.includes(root))) {
    return true;
  }
  return testSuffixes.some(suffix => fsPath.endsWith(suffix));
}

export async function isImportLocation(loc: vscode.Location): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const lineText = doc.lineAt(loc.range.start.line).text.trimStart();
    return lineText.startsWith('import ');
  } catch {
    return false;
  }
}

export async function filterLocations(
  locations: vscode.Location[],
  filterTests: boolean,
  filterImports: boolean
): Promise<vscode.Location[]> {
  const results: vscode.Location[] = [];

  for (const loc of locations) {
    if (filterTests && isTestLocation(loc)) {
      continue;
    }
    if (filterImports && (await isImportLocation(loc))) {
      continue;
    }
    results.push(loc);
  }

  return results;
}
