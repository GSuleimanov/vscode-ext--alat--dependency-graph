import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandViaTypeDefinitions, isTypeSymbolAt, enclosingTypeRoleAt, symbolRoleAt, subjectRoleAt,
  Loc, DocSymbol, SymbolRole, TypeExpansionExecutor,
} from '../expandViaType';

// ── Helpers ───────────────────────────────────────────────────────────────────

function loc(fsPath: string, line: number, character = 0): Loc {
  return {
    uri: { toString: () => `file://${fsPath}`, fsPath },
    range: { start: { line, character } },
  };
}

/** A document symbol on a single line: full range [startChar,endChar], name at nameChar. */
function sym(role: SymbolRole, line: number, startChar: number, endChar: number, nameChar: number): DocSymbol {
  return {
    role,
    range: { start: { line, character: startChar }, end: { line, character: endChar } },
    selectionRange: { start: { line, character: nameChar }, end: { line, character: nameChar } },
  };
}

function executor(overrides: Partial<TypeExpansionExecutor> = {}): TypeExpansionExecutor {
  return {
    executeReferences:   async () => [],
    executeDefinitions:  async () => [],
    getDocumentSymbols:  async () => [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('expandViaTypeDefinitions', () => {

  it('returns unchanged results when no type definitions exist', async () => {
    const raw = [loc('/CoachService.java', 117)];
    const result = await expandViaTypeDefinitions(
      { rawLocations: raw, typeDefLocations: [], defLocations: [], symbolName: 'repo' },
      executor()
    );
    assert.equal(result.rawLocations.length, 1);
    assert.equal(result.defLocations.length, 0);
  });

  it('merges cross-file type references into rawLocations', async () => {
    const typeDef = loc('/Repo.java', 4);
    const existing = loc('/ServiceA.java', 10);
    const crossFile = loc('/ServiceB.java', 18);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [existing], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences: async (uri) => uri.fsPath === '/Repo.java' ? [existing, crossFile] : [],
      })
    );

    assert.equal(result.rawLocations.length, 2, 'should include existing + cross-file, no duplicate');
    assert.ok(result.rawLocations.some(l => l.uri.fsPath === '/ServiceB.java'));
  });

  it('classifies cross-file field declarations as definitions', async () => {
    const typeDef = loc('/Repo.java', 4);
    // "private final Repo repo;" — type "Repo" at col 14, field name "repo" at col 19.
    const fieldDecl = loc('/ServiceB.java', 18, 14);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences:  async (uri) => uri.fsPath === '/Repo.java' ? [fieldDecl] : [],
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getDocumentSymbols: async (uri) =>
          uri.fsPath === '/ServiceB.java' ? [sym('field', 18, 2, 24, 19)] : [],
      })
    );

    assert.ok(result.defLocations.some(l => l.uri.fsPath === '/ServiceB.java'),
      'field declaration should be in defLocations');
  });

  it('does not classify references whose definition does not resolve to the type', async () => {
    const typeDef = loc('/Repo.java', 4);
    const fieldDecl = loc('/ServiceB.java', 18, 14);
    const someOtherDef = loc('/OtherClass.java', 10);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences:  async (uri) => uri.fsPath === '/Repo.java' ? [fieldDecl] : [],
        executeDefinitions: async () => [someOtherDef], // does NOT point back to typeDef
        getDocumentSymbols: async () => [sym('field', 18, 2, 24, 19)],
      })
    );

    assert.equal(result.defLocations.length, 0, 'mismatched-type field should not be a definition');
  });

  it('does not classify a method that returns the type as a definition', async () => {
    // "public Repo getRepo(Long id) {" spanning a Method symbol — the type "Repo"
    // sits inside a Method, so the LSP role is 'method', not 'field'.
    const typeDef = loc('/Repo.java', 4);
    const returnTypeRef = loc('/ServiceB.java', 12, 9);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences:  async (uri) => uri.fsPath === '/Repo.java' ? [returnTypeRef] : [],
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getDocumentSymbols: async () => [sym('method', 12, 2, 30, 14)], // getRepo at col 14
      })
    );

    assert.equal(result.defLocations.length, 0,
      'a method returning the type is a usage, not a definition of the type');
  });

  it('fetches method-call usages at the field name position (from selectionRange)', async () => {
    const typeDef = loc('/Repo.java', 4);
    const fieldDecl = loc('/ServiceB.java', 18, 14); // type "Repo" at col 14
    const nameCol = 19;                               // "repo" at col 19
    let capturedPos: { line: number; character: number } | undefined;

    const result = await expandViaTypeDefinitions(
      { rawLocations: [], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences: async (uri, pos) => {
          if (uri.fsPath === '/Repo.java') { return [fieldDecl]; }
          if (uri.fsPath === '/ServiceB.java') { capturedPos = pos; return [loc('/ServiceB.java', 25)]; }
          return [];
        },
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getDocumentSymbols: async () => [sym('field', 18, 2, 24, nameCol)],
      })
    );

    assert.deepEqual(capturedPos, { line: 18, character: nameCol },
      'reference provider should be called at the field name, not the type name');
    assert.ok(result.rawLocations.some(l => l.range.start.line === 25),
      'method call usage should appear in rawLocations');
  });

  it('deduplicates locations that appear in multiple fetches', async () => {
    const typeDef = loc('/Repo.java', 4);
    const fieldDecl = loc('/ServiceB.java', 18, 14);
    const usage = loc('/ServiceB.java', 25);

    const result = await expandViaTypeDefinitions(
      { rawLocations: [usage], typeDefLocations: [typeDef], defLocations: [], symbolName: 'repo' },
      executor({
        executeReferences: async (uri) => {
          if (uri.fsPath === '/Repo.java') { return [fieldDecl]; }
          if (uri.fsPath === '/ServiceB.java') { return [usage, loc('/ServiceB.java', 30)]; }
          return [];
        },
        executeDefinitions: async (uri) => uri.fsPath === '/ServiceB.java' ? [typeDef] : [],
        getDocumentSymbols: async () => [sym('field', 18, 2, 24, 19)],
      })
    );

    const lines = result.rawLocations.map(l => l.range.start.line);
    assert.equal(lines.length, new Set(lines).size, 'no duplicate locations');
  });

  // ── Type-name invocation ──────────────────────────────────────────────────────

  describe('isTypeInvocation (invoking on the type/class name itself)', () => {

    it('promotes field declarations but not method declarations or generic usages', async () => {
      const typeDecl = loc('/Repo.java', 4); // Repo's own declaration

      // Mirrors the reported screenshot: a field decl (→ Definition) alongside methods
      // that return Repo / List<Repo> and a "new Repo()" (all → References, since the
      // LSP encloses them in Method symbols, not Field symbols).
      const refs: Record<string, Loc> = {
        '/ServiceA.java': loc('/ServiceA.java', 10, 14), // field:   Repo repo
        '/ServiceB.java': loc('/ServiceB.java', 12, 9),  // method:  Repo getRepo()
        '/ServiceC.java': loc('/ServiceC.java', 8, 14),  // method:  List<Repo> getAll()
        '/Factory.java':  loc('/Factory.java', 7, 15),   // method:  new Repo()
      };
      const symbols: Record<string, DocSymbol[]> = {
        '/ServiceA.java': [sym('field', 10, 2, 24, 19)],
        '/ServiceB.java': [sym('method', 12, 2, 30, 14)],
        '/ServiceC.java': [sym('method', 8, 2, 28, 19)],
        '/Factory.java':  [sym('method', 5, 2, 12, 6)],
      };

      const result = await expandViaTypeDefinitions(
        {
          rawLocations: Object.values(refs),
          typeDefLocations: [],
          defLocations: [typeDecl],
          symbolName: 'Repo',
          isTypeInvocation: true,
        },
        executor({
          executeDefinitions: async () => [typeDecl], // every occurrence resolves to the type
          executeReferences:  async () => [],
          getDocumentSymbols: async (uri) => symbols[uri.fsPath] ?? [],
        })
      );

      const defPaths = result.defLocations.map(l => l.uri.fsPath);
      assert.ok(defPaths.includes('/ServiceA.java'), 'field declaration → Definition');
      assert.ok(!defPaths.includes('/ServiceB.java'), 'method returning Repo → not a Definition');
      assert.ok(!defPaths.includes('/ServiceC.java'), 'method returning List<Repo> → not a Definition');
      assert.ok(!defPaths.includes('/Factory.java'), '"new Repo()" → not a Definition');
    });

    it('fetches method-call usages at the declared field name', async () => {
      const typeDecl = loc('/Repo.java', 4);
      const fieldDecl = loc('/ServiceA.java', 10, 14); // type "Repo" at col 14
      const nameCol = 19;                               // field name at col 19
      let capturedPos: { line: number; character: number } | undefined;

      const result = await expandViaTypeDefinitions(
        {
          rawLocations: [fieldDecl],
          typeDefLocations: [],
          defLocations: [typeDecl],
          symbolName: 'Repo',
          isTypeInvocation: true,
        },
        executor({
          executeDefinitions: async () => [typeDecl],
          executeReferences: async (_uri, pos) => { capturedPos = pos; return [loc('/ServiceA.java', 25)]; },
          getDocumentSymbols: async () => [sym('field', 10, 2, 24, nameCol)],
        })
      );

      assert.deepEqual(capturedPos, { line: 10, character: nameCol });
      assert.ok(result.rawLocations.some(l => l.range.start.line === 25),
        'method-call usage should be added as a reference');
    });

    it('leaves results untouched when the type has no own definition', async () => {
      const ref = loc('/ServiceA.java', 10, 14);
      const result = await expandViaTypeDefinitions(
        { rawLocations: [ref], typeDefLocations: [], defLocations: [], symbolName: 'Repo', isTypeInvocation: true },
        executor()
      );
      assert.equal(result.rawLocations.length, 1);
      assert.equal(result.defLocations.length, 0);
    });

  });

  describe('isTypeSymbolAt', () => {
    const symbols: DocSymbol[] = [
      sym('type', 4, 0, 40, 13),   // class Repo {            (name at col 13)
      sym('field', 10, 2, 24, 19), // private Repo repo;      (name at col 19)
    ];

    it('is true when the position lands on a type declaration name', () => {
      assert.ok(isTypeSymbolAt(symbols, 4, 13));
    });
    it('is true for an interface declaration name too', () => {
      assert.ok(isTypeSymbolAt([sym('interface', 2, 0, 20, 17)], 2, 17));
    });
    it('is false when the position lands inside a field declaration', () => {
      assert.ok(!isTypeSymbolAt(symbols, 10, 14));
    });
    it('is false when nothing encloses the position', () => {
      assert.ok(!isTypeSymbolAt(symbols, 99, 0));
    });
  });

  describe('symbol role lookups', () => {
    // Multi-line range: a type/interface (lines 2–10) containing a method (lines 6–8).
    const ml = (role: SymbolRole, sl: number, sc: number, el: number, ec: number): DocSymbol => ({
      role,
      range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
      selectionRange: { start: { line: sl, character: sc }, end: { line: sl, character: sc } },
    });
    const symbols: DocSymbol[] = [ml('interface', 2, 0, 10, 1), ml('method', 6, 4, 8, 5)];

    it('symbolRoleAt returns the innermost role (the method)', () => {
      assert.equal(symbolRoleAt(symbols, 6, 11), 'method');
    });
    it('enclosingTypeRoleAt returns the enclosing interface, not the method', () => {
      assert.equal(enclosingTypeRoleAt(symbols, 6, 11), 'interface');
    });
    it('enclosingTypeRoleAt returns the enclosing type for a method in a class', () => {
      const inClass: DocSymbol[] = [ml('type', 2, 0, 10, 1), ml('method', 6, 4, 8, 5)];
      assert.equal(enclosingTypeRoleAt(inClass, 6, 11), 'type');
    });

    // The Java LSP does not emit parameters/locals as symbols, so a peek on one resolves
    // to the enclosing Method symbol. subjectRoleAt must NOT call that a method peek.
    // ml() places the method name (selectionRange) at the method's start point (6, 4).
    it('subjectRoleAt reports a method as a method when on its name', () => {
      assert.equal(subjectRoleAt(symbols, 6, 4), 'method');
    });
    it('subjectRoleAt reports a parameter/local inside a method as a field', () => {
      assert.equal(subjectRoleAt(symbols, 6, 11), 'field');
    });
    it('subjectRoleAt is undefined when nothing encloses the position', () => {
      assert.equal(subjectRoleAt(symbols, 99, 0), undefined);
    });
  });

});
