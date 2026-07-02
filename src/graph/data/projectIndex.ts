// Project-wide symbol table and its inverse, built from tree-sitter parses we
// already run per file. This is the data source that replaces the LSP fan-out
// (executeReferenceProvider / executeWorkspaceSymbolProvider) on the graph's hot
// path: once warm, "who calls C" and "where is type T defined" are Map lookups
// (microseconds) instead of 200–500 ms server round-trips — and they work for
// every registered language uniformly, with no dependency on Pylance/gopls.
//
// Pure and VSCode-free, like tieredGraphBuilder: the VSCode glue (file
// enumeration, watchers, disk snapshot) lives in indexService.ts, and this core
// is unit-tested with fake projects (see __tests__/projectIndex.test.ts).

import { ParsedType, TypeKind } from '../core/types';

export interface IndexedDef {
  name: string;   // simple type name (nested Java types keep their Outer.Inner form)
  uri: string;    // defining file
  line: number;   // 0-based declaration line
  kind: TypeKind;
}

// Everything the index knows about one file: the types it defines and the type
// names it references. Extracted per file by the language provider (tree-sitter),
// so updating a file is a self-contained diff — no other file needs re-parsing.
export interface FileFacts {
  uri: string;
  defs: IndexedDef[];
  refs: string[];
}

export interface IndexStats {
  files: number;     // files indexed
  symbols: number;   // total definitions
  refs: number;      // total name→file reference entries
}

export interface ProjectIndex {
  /** Where is `name` defined? (forward lookup — replaces executeWorkspaceSymbolProvider) */
  defsOf(name: string): IndexedDef[];
  /** Which files mention `name`? (reverse lookup — replaces executeReferenceProvider) */
  callerFilesOf(name: string): string[];
  /** Replace one file's contribution (incremental — on save/create). */
  upsertFile(uri: string, defs: IndexedDef[], refs: string[]): void;
  /** Drop one file's contribution (on delete). */
  removeFile(uri: string): void;
  /** True once the initial cold build (or snapshot load) has completed. */
  ready(): boolean;
  markReady(): void;
  stats(): IndexStats;
  /** Serializable per-file facts, for the disk snapshot. */
  snapshot(): FileFacts[];
}

/** Index defs from a file's parsed types. */
export function defsFromTypes(types: ParsedType[], uri: string): IndexedDef[] {
  return types.map(t => ({ name: t.name, uri, line: t.line, kind: t.kind }));
}

/**
 * Fallback ref extraction for providers without a dedicated `refNames`: the union
 * of every declaration's field types and supertypes. Java's per-decl `fieldTypes`
 * already walks method bodies, so this covers it; query-driven languages override
 * with a whole-file pass (module-level code included).
 */
export function refsFromTypes(types: ParsedType[]): string[] {
  const refs = new Set<string>();
  const own = new Set(types.map(t => t.name));
  for (const t of types) {
    for (const n of [...t.fieldTypes, ...t.extendsNames, ...t.implementsNames]) {
      if (!own.has(n)) { refs.add(n); }
    }
  }
  return [...refs];
}

export function createProjectIndex(files: FileFacts[] = []): ProjectIndex {
  const defIndex = new Map<string, IndexedDef[]>();   // name → where it is defined
  const refIndex = new Map<string, Set<string>>();    // name → files that mention it
  const fileDefs = new Map<string, IndexedDef[]>();   // uri → its defs (incremental teardown)
  const fileRefs = new Map<string, string[]>();       // uri → its refs (incremental teardown)
  let isReady = false;

  function removeFile(uri: string): void {
    for (const def of fileDefs.get(uri) ?? []) {
      const list = defIndex.get(def.name);
      if (!list) { continue; }
      const kept = list.filter(d => d.uri !== uri);
      if (kept.length) { defIndex.set(def.name, kept); } else { defIndex.delete(def.name); }
    }
    for (const name of fileRefs.get(uri) ?? []) {
      const set = refIndex.get(name);
      if (!set) { continue; }
      set.delete(uri);
      if (!set.size) { refIndex.delete(name); }
    }
    fileDefs.delete(uri);
    fileRefs.delete(uri);
  }

  function upsertFile(uri: string, defs: IndexedDef[], refs: string[]): void {
    removeFile(uri);
    if (defs.length) {
      fileDefs.set(uri, defs);
      for (const def of defs) {
        const list = defIndex.get(def.name);
        if (list) { list.push(def); } else { defIndex.set(def.name, [def]); }
      }
    }
    const uniqueRefs = [...new Set(refs)];
    if (uniqueRefs.length) {
      fileRefs.set(uri, uniqueRefs);
      for (const name of uniqueRefs) {
        const set = refIndex.get(name);
        if (set) { set.add(uri); } else { refIndex.set(name, new Set([uri])); }
      }
    }
  }

  for (const f of files) { upsertFile(f.uri, f.defs, f.refs); }

  return {
    defsOf: (name) => defIndex.get(name)?.slice() ?? [],
    callerFilesOf: (name) => [...(refIndex.get(name) ?? [])],
    upsertFile,
    removeFile,
    ready: () => isReady,
    markReady: () => { isReady = true; },
    stats: () => {
      let symbols = 0, refs = 0;
      for (const defs of fileDefs.values()) { symbols += defs.length; }
      for (const set of refIndex.values()) { refs += set.size; }
      return { files: new Set([...fileDefs.keys(), ...fileRefs.keys()]).size, symbols, refs };
    },
    snapshot: () => {
      const uris = new Set([...fileDefs.keys(), ...fileRefs.keys()]);
      return [...uris].map(uri => ({
        uri, defs: fileDefs.get(uri) ?? [], refs: fileRefs.get(uri) ?? [],
      }));
    },
  };
}
