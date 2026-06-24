import * as vscode from 'vscode';
import { ReferencesSideView, PanelInput, PeekSink } from '../views/referencesSideView';
import { getConfig, isJavaKeyword } from '../util/javaUtils';
import { PeekOutcome, buildResultsOutcome } from './peekOutcome';
import {
  expandViaTypeDefinitions, TypeExpansionExecutor, subjectRoleAt, enclosingTypeRoleAt,
  DocSymbol, SymbolRole,
} from './expandViaType';
import { searchProjectReferences } from './projectScopedRefs';

/**
 * The redhat.java language server only answers reference/definition/implementation queries
 * once it has fully started in "Standard" mode. During the LightWeight/Hybrid startup phase
 * (while VSCode shows "Java language server starting…") those queries return nothing, so a
 * peek would silently produce empty results. Returns false until the server is ready.
 */
function isJavaServerReady(): boolean {
  const ext = vscode.extensions.getExtension('redhat.java');
  if (!ext) { return true; }             // no Java LS extension — let the normal path report it
  if (!ext.isActive) { return false; }   // extension still activating
  const mode = (ext.exports as { serverMode?: string } | undefined)?.serverMode;
  return mode === undefined || mode === 'Standard';  // undefined => older API without modes; assume ready
}

function symbolRole(kind: vscode.SymbolKind): SymbolRole {
  switch (kind) {
    case vscode.SymbolKind.EnumMember:
      return 'enumMember';
    case vscode.SymbolKind.Field:
    case vscode.SymbolKind.Property:
    case vscode.SymbolKind.Constant:
    case vscode.SymbolKind.Variable:
      return 'field';
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
    case vscode.SymbolKind.Function:
      return 'method';
    case vscode.SymbolKind.Interface:
      return 'interface';
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Enum:
    case vscode.SymbolKind.Struct:
      return 'type';
    default:
      return 'other';
  }
}

const toRange = (r: vscode.Range) => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
});

/** Flatten the (possibly hierarchical) document symbols into a DocSymbol list. */
function flattenSymbols(raw: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): DocSymbol[] {
  const out: DocSymbol[] = [];
  const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation) => {
    const range = (s as vscode.DocumentSymbol).range ?? (s as vscode.SymbolInformation).location?.range;
    if (!range) { return; }
    const selectionRange = (s as vscode.DocumentSymbol).selectionRange ?? range;
    out.push({ role: symbolRole(s.kind), range: toRange(range), selectionRange: toRange(selectionRange) });
    for (const child of (s as vscode.DocumentSymbol).children ?? []) { visit(child); }
  };
  raw.forEach(visit);
  return out;
}

/**
 * For a method call `receiver.method(...)`, returns a position on the `receiver`
 * identifier (so we can resolve the receiver's type). Returns undefined for static
 * calls, chained calls (`a.b().method`), or anything that isn't a simple identifier
 * receiver on the same line.
 */
function findReceiverPosition(
  document: vscode.TextDocument, methodRange: vscode.Range
): vscode.Position | undefined {
  const line = document.lineAt(methodRange.start.line).text;
  let i = methodRange.start.character - 1;
  while (i >= 0 && /\s/.test(line[i])) { i--; }
  if (i < 0 || line[i] !== '.') { return undefined; } // no receiver (not `x.method`)
  i--;
  while (i >= 0 && /\s/.test(line[i])) { i--; }
  if (i < 0 || !/[A-Za-z0-9_$]/.test(line[i])) { return undefined; } // chained/complex receiver
  return new vscode.Position(methodRange.start.line, i);
}

export function createPeekFilteredCommand(
  view: ReferencesSideView,
  onFocusClass?: (uri: vscode.Uri) => void
) {
  // Returns a structured outcome (also rendered in the panel) so tests can assert what
  // the peek decided without scraping the webview.
  return async (): Promise<PeekOutcome> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'java') { return { status: 'noEditor' }; }

    const { document, selection } = editor;
    const position = selection.active;
    const wordRange = document.getWordRangeAtPosition(position);
    const symbolName = wordRange ? document.getText(wordRange) : 'symbol';

    // Block peeking until the Java language server has fully started. While it is still
    // starting, reference/definition queries return nothing, so a peek would silently
    // produce empty results — refuse with a hint instead.
    if (!isJavaServerReady()) {
      const message = 'Java Language Server is still starting — try again in a moment.';
      vscode.window.setStatusBarMessage(`Codenav: ${message}`, 4000);
      return { status: 'refused', symbolName, message };
    }

    // Import statements and the package declaration are not navigable subjects — peeking a
    // class name there would surface the type's references (noise). Refuse early.
    const lineText = document.lineAt(position.line).text;
    if (/^\s*(import|package)\b/.test(lineText)) {
      const kind = /^\s*import\b/.test(lineText) ? 'an import' : 'a package';
      return { status: 'refused', symbolName, message: `"${symbolName}" is on ${kind} statement, not a navigable symbol.` };
    }

    // Center the project graph (if open) on the class being peeked.
    onFocusClass?.(document.uri);

    // Keywords/modifiers/literals (try, catch, finally, return, var, class, enum,
    // interface, …) are not navigable symbols. Bail before any loading/LSP work so a
    // stray peek on a keyword neither clears the current panel nor starts a search.
    if (!wordRange || isJavaKeyword(symbolName)) {
      return { status: 'refused', symbolName, message: `"${symbolName}" is a Java keyword, not a symbol.` };
    }

    // Re-peeking the same element (e.g. Esc back to the origin line, then peek again)
    // reuses the already-computed results unless an edit has invalidated them.
    if (await view.reshow(document.uri.toString(), position.line, position.character, symbolName)) {
      return { status: 'results', symbolName };
    }

    // Same symbol peeked again at a different occurrence already in the results: just
    // move the "current" marker to it (no recompute).
    if (await view.moveCurrentTo(document.uri.toString(), position.line, position.character, symbolName)) {
      return { status: 'results', symbolName };
    }

    const runPeek = async (): Promise<PeekOutcome> => {
    // Show the loading screen immediately and tag this request so a slower, older
    // invocation can't overwrite the results of a newer one when it finishes late.
    const reqId = await view.beginLoading(symbolName);
    // Stop early if a newer peek superseded this one. (A search can't be interrupted
    // mid-flight once the language server is working, so there is no user "cancel".)
    const aborted = () => !view.isCurrent(reqId);

    const executor: TypeExpansionExecutor = {
      executeReferences: (uri, pos) =>
        Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider', uri, new vscode.Position(pos.line, pos.character)
        )).then(r => r ?? []).catch(() => []),
      executeDefinitions: (uri, pos) =>
        Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', uri, new vscode.Position(pos.line, pos.character)
        )).then(r => r ?? []).catch(() => []),
      getDocumentSymbols: (uri) =>
        Promise.resolve(vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
          'vscode.executeDocumentSymbolProvider', uri as vscode.Uri
        )).then(r => flattenSymbols(r ?? [])).catch(() => []),
    };

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const isWorkspaceLoc = (l: vscode.Location) =>
      l.uri.scheme === 'file' && (!wsRoot || l.uri.fsPath.startsWith(wsRoot));

    // Results are scoped to this project plus the packages configured in
    // "codenav.includePackagePrefixes". Everything else (JDK, third-party libs)
    // is out of scope — both hidden from results and (critically) never searched.
    const includePrefixes = (getConfig().get<string[]>('includePackagePrefixes') ?? []).filter(Boolean);
    const inScope = (l: vscode.Location): boolean => {
      if (isWorkspaceLoc(l)) { return true; }
      if (includePrefixes.length === 0) { return false; }
      const s = l.uri.toString();
      // Library locations carry the package either dotted (jdt:// jar contents) or as
      // path segments; match both forms of each configured prefix.
      return includePrefixes.some(p => s.includes(p) || s.includes(p.replace(/\./g, '/')));
    };
    // JDK / standard-library locations: searching their references walks the entire
    // codebase and can OOM the language server (and the search keeps running after the
    // window closes). Used as a hard guardrail below. JDK symbols always resolve into a
    // jar (non-workspace, e.g. jdt://…/java.base/java.lang/String.class); we must exclude
    // workspace files, whose Maven path "src/main/java/…" also contains "java".
    const isJdkLoc = (l: vscode.Location): boolean =>
      !isWorkspaceLoc(l) && /[/.](?:java|javax|jakarta|jdk|sun|com\.sun)[/.]/.test(l.uri.toString());

    const execLocs = (cmd: string, uri: vscode.Uri, pos: vscode.Position) =>
      Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(cmd, uri, pos))
        .then(r => r ?? []).catch(() => []);
    const key = (l: vscode.Location) => `${l.uri.fsPath}:${l.range.start.line}`;

    // Resolve the symbol cheaply first (definition/type), so we can predict an
    // unbounded search BEFORE running the expensive reference provider.
    let typeDefLocations: vscode.Location[] = [];
    let defLocations: vscode.Location[] = [];
    try {
      [defLocations, typeDefLocations] = await Promise.all([
        execLocs('vscode.executeDefinitionProvider', document.uri, position),
        execLocs('vscode.executeTypeDefinitionProvider', document.uri, position),
      ]);
    } catch {
      const message = 'Java Language Server is required but not available.';
      view.fail(reqId, message);
      vscode.window.showErrorMessage(`Codenav: ${message}`);
      return { status: 'refused', symbolName, message };
    }

    // Classify what was peeked: a type/interface name, a method, an enum constant, or
    // an instance variable.
    let isTypeInvocation = false;
    let isMethodPeek = false;
    let isEnumMember = false;
    let declInInterface = false;
    let defExternal = false;
    const def0 = defLocations[0];
    if (def0) {
      // "External" here means "not a workspace file" (resolved into a jar with no local
      // symbols) — used to detect library members; scoping is handled by inScope.
      defExternal = !isWorkspaceLoc(def0);
      const symbols = await executor.getDocumentSymbols(def0.uri);
      const role = subjectRoleAt(symbols, def0.range.start.line, def0.range.start.character);
      const enclosing = enclosingTypeRoleAt(symbols, def0.range.start.line, def0.range.start.character);
      isTypeInvocation = role === 'type' || role === 'interface';
      // External (library) members resolve into a jar with no local symbols — treat as methods.
      isMethodPeek = role === 'method' || (role === undefined && defExternal);
      // A single enum constant (e.g. WaitlistStatus.PROMOTED). Peeking the enum *type*
      // is a type invocation (all constants/usages); peeking one *constant* must stay
      // scoped to that constant, so it skips type expansion below.
      isEnumMember = role === 'enumMember';
      declInInterface = enclosing === 'interface';
    }

    // For a method call the relevant subject is the receiver's type.
    const recvPos = (isMethodPeek && wordRange) ? findReceiverPosition(document, wordRange) : undefined;
    const recvTypeDef = recvPos
      ? await execLocs('vscode.executeTypeDefinitionProvider', document.uri, recvPos)
      : [];

    const originUriStr = document.uri.toString();
    const inOriginFile = (l: vscode.Location) => l.uri.toString() === originUriStr;
    const mkInput = (parts: Partial<PanelInput>): PanelInput => ({
      symbolName, originUri: document.uri, originPosition: position,
      rawLocations: [], typeDefLocations: [], defLocations: [], implLocations: [], interfaceLocations: [],
      ...parts,
    });

    // GUARDRAIL — a subject whose definition lives in the JDK / standard library
    // (String, Object#toString, List, …) must NOT go through the reference provider:
    // JDT would walk the entire index, which can exhaust the language server and keeps
    // running (uncancellable) after the window closes. We instead run a project-bounded
    // search that scans the workspace's own files and identity-verifies each candidate.
    let dangerous = false;
    if (isTypeInvocation || isMethodPeek) {
      const subjectType = isMethodPeek ? (recvTypeDef[0] ?? def0) : def0;
      dangerous =
        (!!subjectType && isJdkLoc(subjectType)) || (isMethodPeek && !!def0 && isJdkLoc(def0));
    }
    // Identity = the peeked symbol's own declaration(s). A candidate usage in the project
    // is kept only if its definition resolves back to one of these (used by the project
    // search for dangerous subjects).
    const identityKeys = new Set(
      [...defLocations, ...(def0 ? [def0] : [])].map(l => `${l.uri.toString()}:${l.range.start.line}`)
    );

    // For the normal (non-dangerous) path, fetch all references + implementations once;
    // both the current-class (phase 1) and whole-project (phase 2) views reuse them.
    let allRefs: vscode.Location[] = [];
    let baseImpl: vscode.Location[] = [];
    if (!dangerous) {
      try {
        [allRefs, baseImpl] = await Promise.all([
          Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider', document.uri, position
          )).then(r => r ?? []),
          execLocs('vscode.executeImplementationProvider', document.uri, position),
        ]);
      } catch {
        const message = 'Java Language Server is required but not available.';
        view.fail(reqId, message);
        vscode.window.showErrorMessage(`Codenav: ${message}`);
        return { status: 'refused', symbolName, message };
      }
    }

    // ── PHASE 2 — whole-project computation, driven by a sink ──────────────────────
    // The sink lets the same logic feed either the full-screen overlay (not used here)
    // or the inline "loading below results" progress when expanding via the chip.
    const computeProject = async (sink: PeekSink): Promise<PeekOutcome> => {
      if (dangerous) {
        const projectRefs = await searchProjectReferences({
          identityKeys, symbolName,
          isCancelled: sink.isAborted, onProgress: (p) => sink.reportProgress(p),
        });
        if (sink.isAborted()) { return { status: 'cancelled', symbolName }; }
        const scopedRefs = projectRefs.filter(inScope);
        if (scopedRefs.length === 0) {
          const message =
            `No project references found for "${symbolName}" (a JDK / standard-library symbol — ` +
            `only usages within this workspace are searched).`;
          sink.fail(message);
          return { status: 'empty', symbolName, message };
        }
        const input = mkInput({ rawLocations: scopedRefs });
        await sink.show(input);
        return buildResultsOutcome(
          { symbolName, rawLocations: scopedRefs, typeDefLocations: [], defLocations: [], implLocations: [], interfaceLocations: [] },
          wsRoot
        );
      }

      if (allRefs.length === 0) {
        const message = `No references found for "${symbolName}".`;
        sink.fail(message);
        return { status: 'empty', symbolName, message };
      }

      // Local copies so the computation can be re-run without mutating captured state.
      let rawLocations: vscode.Location[] = allRefs.filter(inScope);
      let typeDefL: vscode.Location[] = typeDefLocations;
      let defL: vscode.Location[] = defLocations;
      let implL: vscode.Location[] = baseImpl;
      let interfaceL: vscode.Location[] = [];

      sink.reportProgress({ label: 'Expanding cross-file usages…' });

      if (isMethodPeek) {
        // When the declaration lives in an interface (or an external library such as
        // JpaRepository), present it as the Interface (super) section; otherwise plain.
        if (declInInterface || defExternal) { interfaceL = defL; defL = []; }
        typeDefL = []; // a method's own "type definition" is its return type — noise here.

        if (recvTypeDef.length > 0) {
          typeDefL = recvTypeDef;
          const recvTypeKeys = new Set(recvTypeDef.map(key));
          const receiverTypeAt = async (ref: vscode.Location): Promise<vscode.Location[]> => {
            try {
              const doc = await vscode.workspace.openTextDocument(ref.uri);
              const rp = findReceiverPosition(doc, ref.range);
              return rp ? await execLocs('vscode.executeTypeDefinitionProvider', ref.uri, rp) : [];
            } catch { return []; }
          };
          const refs = rawLocations;
          sink.reportProgress({ label: 'Scoping to receiver type…', done: 0, total: refs.length });
          const kept: vscode.Location[] = [];
          let done = 0;
          for (const ref of refs) {
            if (sink.isAborted()) { break; }
            const types = await receiverTypeAt(ref);
            if (types.some(t => recvTypeKeys.has(key(t)))) { kept.push(ref); }
            sink.reportProgress({ label: 'Scoping to receiver type…', done: ++done, total: refs.length });
          }
          rawLocations = kept;
        }
        // If the receiver type couldn't be resolved, fall back to the method's plain refs.
      } else if (isEnumMember) {
        // A single enum constant: its own reference set already points only at that
        // constant's usages. Do NOT expand via the enum type (that would surface every
        // other constant and every usage of the enum); drop the enum type too.
        typeDefL = [];
      } else {
        const subjectInScope = isTypeInvocation
          ? inScope(def0!)
          : (typeDefL.length > 0 && typeDefL.some(inScope));
        if (subjectInScope) {
          const expanded = await expandViaTypeDefinitions(
            {
              rawLocations, typeDefLocations: typeDefL, defLocations: defL, symbolName,
              isTypeInvocation,
              onProgress: (p) => sink.reportProgress(p),
              isCancelled: sink.isAborted,
            },
            executor
          );
          rawLocations = expanded.rawLocations as vscode.Location[];
          defL = expanded.defLocations as vscode.Location[];
        } else {
          typeDefL = []; // out-of-scope-typed field: show its own (in-scope) references only
        }
      }

      rawLocations = rawLocations.filter(inScope);
      typeDefL = typeDefL.filter(inScope);
      interfaceL = interfaceL.filter(inScope);
      implL = implL.filter(inScope);
      defL = defL.filter(inScope);

      if (sink.isAborted()) { return { status: 'cancelled', symbolName }; }

      const input = mkInput({
        rawLocations, typeDefLocations: typeDefL, defLocations: defL,
        implLocations: implL, interfaceLocations: interfaceL,
      });
      await sink.show(input);
      return buildResultsOutcome(
        { symbolName, rawLocations, typeDefLocations: typeDefL, defLocations: defL, implLocations: implL, interfaceLocations: interfaceL },
        wsRoot
      );
    };

    // ── PHASE 1 — current-class results, shown instantly ───────────────────────────
    let ccRefs: vscode.Location[];
    if (dangerous) {
      ccRefs = (await searchProjectReferences({
        identityKeys, symbolName, restrictToFile: document.uri,
        isCancelled: aborted, onProgress: (p) => view.reportProgress(reqId, p),
      })).filter(inScope);
    } else {
      if (allRefs.length === 0) {
        const message = `No references found for "${symbolName}".`;
        view.fail(reqId, message);
        return { status: 'empty', symbolName, message };
      }
      ccRefs = allRefs.filter(inScope).filter(inOriginFile);
    }
    if (aborted()) { return { status: 'cancelled', symbolName }; }

    const ccInput = dangerous
      ? mkInput({ rawLocations: ccRefs })
      : mkInput({
          rawLocations: ccRefs,
          typeDefLocations: (isEnumMember ? [] : typeDefLocations).filter(inScope).filter(inOriginFile),
          defLocations: defLocations.filter(inScope).filter(inOriginFile),
          implLocations: baseImpl.filter(inScope).filter(inOriginFile),
        });

    // Register the on-demand loader so toggling the chip off can expand to the project.
    view.setProjectLoader(reqId, computeProject);
    // Show the current class immediately (full=false: the whole project isn't loaded yet).
    await view.show(ccInput, reqId, false);

    if (view.currentClassMode) {
      // Fast mode: stop here; the whole project loads only when the chip is toggled off.
      return buildResultsOutcome(
        {
          symbolName, rawLocations: ccInput.rawLocations,
          typeDefLocations: ccInput.typeDefLocations, defLocations: ccInput.defLocations,
          implLocations: ccInput.implLocations, interfaceLocations: ccInput.interfaceLocations ?? [],
        },
        wsRoot
      );
    }

    // Progressive (chip off): load the whole project below the current-class results.
    return await view.loadProject(reqId);
    }; // runPeek

    return runPeek();
  };
}
