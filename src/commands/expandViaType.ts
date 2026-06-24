// Pure expansion logic — injectable executor makes this unit-testable without VSCode.
// Classification is driven entirely by the LSP (document symbols + definitions);
// no source text is parsed here.

export interface Pos { line: number; character: number; }
export interface Range { start: Pos; end: Pos; }

export interface Loc {
  uri: { toString(): string; fsPath: string };
  range: { start: Pos };
}

/** Normalised role of a document symbol, mapped from vscode.SymbolKind by the caller.
 *  'type' covers classes/enums/structs; interfaces are kept distinct as 'interface';
 *  'enumMember' is a single enum constant (e.g. PROMOTED), kept distinct from a typed
 *  'field' so peeking one narrows to that constant instead of expanding via its type. */
export type SymbolRole = 'field' | 'method' | 'type' | 'interface' | 'enumMember' | 'other';

export interface DocSymbol {
  role: SymbolRole;
  range: Range;          // full declaration range
  selectionRange: Range; // the name range (for a field, the variable name)
}

export interface TypeExpansionExecutor {
  executeReferences(uri: Loc['uri'], pos: Pos): Promise<Loc[]>;
  executeDefinitions(uri: Loc['uri'], pos: Pos): Promise<Loc[]>;
  /** Flattened document symbols for a file (parents and children). */
  getDocumentSymbols(uri: Loc['uri']): Promise<DocSymbol[]>;
}

export interface ProgressUpdate { label: string; done?: number; total?: number; }
export type ProgressReporter = (p: ProgressUpdate) => void;

export interface TypeExpansionInput {
  rawLocations: Loc[];
  typeDefLocations: Loc[];
  defLocations: Loc[];
  symbolName: string;
  /** True when the cursor is on a type/class name itself rather than an instance variable. */
  isTypeInvocation?: boolean;
  /** Optional callback to report long-running expansion progress to the UI. */
  onProgress?: ProgressReporter;
  /** Optional cooperative-cancellation check; when it returns true, expansion stops early. */
  isCancelled?: () => boolean;
}

export interface TypeExpansionResult {
  rawLocations: Loc[];
  defLocations: Loc[];
}

const fsLineKey = (l: Loc) => `${l.uri.fsPath}:${l.range.start.line}`;
const uriLineKey = (l: Loc) => `${l.uri.toString()}:${l.range.start.line}`;

function contains(r: Range, line: number, ch: number): boolean {
  const afterStart = line > r.start.line || (line === r.start.line && ch >= r.start.character);
  const beforeEnd = line < r.end.line || (line === r.end.line && ch <= r.end.character);
  return afterStart && beforeEnd;
}

function rangeSpan(r: Range): number {
  return (r.end.line - r.start.line) * 1_000_000 + (r.end.character - r.start.character);
}

/** The innermost (smallest) symbol whose full range encloses the position. */
function innermostSymbolAt(symbols: DocSymbol[], line: number, ch: number): DocSymbol | null {
  let best: DocSymbol | null = null;
  for (const s of symbols) {
    if (contains(s.range, line, ch) && (!best || rangeSpan(s.range) < rangeSpan(best.range))) {
      best = s;
    }
  }
  return best;
}

/** The role of the innermost symbol enclosing the position, if any. */
export function symbolRoleAt(symbols: DocSymbol[], line: number, character: number): SymbolRole | undefined {
  return innermostSymbolAt(symbols, line, character)?.role;
}

/**
 * Like {@link symbolRoleAt}, but refined for method parameters and local variables.
 * The redhat.java LSP does not emit parameters or locals as document symbols, so a peek
 * on one resolves to the *enclosing* Method symbol — which would misclassify a typed
 * variable as a method call. When the position is inside a method's full range but NOT
 * on the method's name (its selectionRange), we report 'field' instead, so the caller
 * treats it as a typed instance variable and runs type-definition expansion.
 */
export function subjectRoleAt(symbols: DocSymbol[], line: number, character: number): SymbolRole | undefined {
  const sym = innermostSymbolAt(symbols, line, character);
  if (!sym) { return undefined; }
  if (sym.role === 'method' && !contains(sym.selectionRange, line, character)) {
    return 'field'; // parameter or local variable — not the method itself
  }
  return sym.role;
}

/** The role ('type' | 'interface') of the innermost type/interface enclosing the position. */
export function enclosingTypeRoleAt(symbols: DocSymbol[], line: number, character: number): SymbolRole | undefined {
  let best: DocSymbol | null = null;
  for (const s of symbols) {
    if ((s.role === 'type' || s.role === 'interface') && contains(s.range, line, character)
        && (!best || rangeSpan(s.range) < rangeSpan(best.range))) {
      best = s;
    }
  }
  return best?.role;
}

/** True when the position lands on the name of a type/interface declaration. */
export function isTypeSymbolAt(symbols: DocSymbol[], line: number, character: number): boolean {
  const role = innermostSymbolAt(symbols, line, character)?.role;
  return role === 'type' || role === 'interface';
}

interface Declaration { loc: Loc; namePos: Pos; }

/**
 * Among `candidates` (locations that reference the type), keep the ones that are
 * field/variable declarations of the type: the LSP reports the enclosing symbol as a
 * field, and the location's definition resolves back to the type. A method that
 * merely *returns* the type is enclosed by a Method symbol, so it is left as a
 * reference. The field's `selectionRange` gives the variable name position.
 */
async function classifyDeclarations(
  candidates: Loc[],
  typeDeclKeys: Set<string>,
  executor: TypeExpansionExecutor,
  onProgress?: ProgressReporter,
  isCancelled?: () => boolean
): Promise<Declaration[]> {
  const byUri = new Map<string, { uri: Loc['uri']; locs: Loc[] }>();
  for (const loc of candidates) {
    const key = loc.uri.toString();
    const bucket = byUri.get(key) ?? { uri: loc.uri, locs: [] };
    bucket.locs.push(loc);
    byUri.set(key, bucket);
  }

  let done = 0;
  const total = candidates.length;
  onProgress?.({ label: 'Classifying usages…', done, total });

  const perFile = await Promise.all(
    Array.from(byUri.values()).map(async ({ uri, locs }) => {
      const symbols = await executor.getDocumentSymbols(uri).catch(() => []);
      const declarations: Declaration[] = [];
      for (const loc of locs) {
        if (isCancelled?.()) { break; }
        const sym = innermostSymbolAt(symbols, loc.range.start.line, loc.range.start.character);
        if (sym && sym.role === 'field') {
          const defs = await executor.executeDefinitions(loc.uri, loc.range.start).catch(() => []);
          if (defs.some(d => typeDeclKeys.has(fsLineKey(d)))) {
            declarations.push({ loc, namePos: sym.selectionRange.start });
          }
        }
        onProgress?.({ label: 'Classifying usages…', done: ++done, total });
      }
      return declarations;
    })
  );

  return perFile.flat();
}

/**
 * Expands a reference search so that invoking on an instance variable, on its type
 * name, or on the type's declaration all yield the same classification:
 *  - field/variable declarations of the type are promoted to Definitions, while
 *    method declarations that merely return the type stay as References;
 *  - the method-call usages on each declared instance are added as References.
 */
export async function expandViaTypeDefinitions(
  input: TypeExpansionInput,
  executor: TypeExpansionExecutor
): Promise<TypeExpansionResult> {
  const rawLocations = [...input.rawLocations];
  const defLocations = [...input.defLocations];

  // Resolve (a) the keys of the type's own declaration and (b) the references to
  // classify, depending on whether we started from the type or an instance variable.
  let typeDeclKeys: Set<string>;
  let candidates: Loc[];

  if (input.isTypeInvocation) {
    // The raw references already point at usages of the type; classify them directly.
    if (input.defLocations.length === 0) { return { rawLocations, defLocations }; }
    typeDeclKeys = new Set(input.defLocations.map(fsLineKey));
    candidates = input.rawLocations;
  } else {
    // Instance variable: follow its type definition outward to cross-file references.
    if (input.typeDefLocations.length === 0) { return { rawLocations, defLocations }; }
    typeDeclKeys = new Set(input.typeDefLocations.map(fsLineKey));

    const refResults = await Promise.all(
      input.typeDefLocations.map(loc =>
        executor.executeReferences(loc.uri, loc.range.start).catch(() => [])
      )
    );
    const seen = new Set(rawLocations.map(uriLineKey));
    candidates = [];
    for (const locs of refResults) {
      for (const loc of locs) {
        const key = uriLineKey(loc);
        if (!seen.has(key)) { seen.add(key); rawLocations.push(loc); candidates.push(loc); }
      }
    }
  }

  // Promote field/variable declarations to Definitions.
  const declarations = await classifyDeclarations(
    candidates, typeDeclKeys, executor, input.onProgress, input.isCancelled
  );
  if (input.isCancelled?.()) { return { rawLocations, defLocations }; }
  const defKeys = new Set(defLocations.map(fsLineKey));
  for (const { loc } of declarations) {
    const key = fsLineKey(loc);
    if (!defKeys.has(key)) { defKeys.add(key); defLocations.push(loc); }
  }

  // Fetch the method-call usages on each declared instance, at the variable name.
  const seen = new Set(rawLocations.map(uriLineKey));
  let callsDone = 0;
  const callsTotal = declarations.length;
  if (callsTotal > 0) { input.onProgress?.({ label: 'Loading method calls…', done: 0, total: callsTotal }); }
  const callResults = await Promise.all(
    declarations.map(async ({ loc, namePos }) => {
      if (input.isCancelled?.()) { return []; }
      const refs = await executor.executeReferences(loc.uri, namePos).catch(() => []);
      input.onProgress?.({ label: 'Loading method calls…', done: ++callsDone, total: callsTotal });
      return refs;
    })
  );
  for (const locs of callResults) {
    for (const loc of locs) {
      const key = uriLineKey(loc);
      if (!seen.has(key)) { seen.add(key); rawLocations.push(loc); }
    }
  }

  return { rawLocations, defLocations };
}
