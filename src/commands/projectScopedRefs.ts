import * as vscode from 'vscode';
import { ProgressUpdate } from './expandViaType';

// Project-bounded reference search for symbols whose own reference provider would be
// unbounded (JDK / standard-library types and methods such as String, List,
// Object#toString). Calling `vscode.executeReferenceProvider` on those triggers JDT's
// whole-index walk, which can exhaust the language server and cannot be cancelled once
// started. Instead we drive the search from OUR side: enumerate the workspace's own
// `.java` files, scan them for the identifier, then confirm each candidate by resolving
// its definition back to the exact symbol that was peeked. The work is bounded by the
// project (not the index), is cooperatively cancellable, and is more precise than a
// scoped reference query — every hit is identity-verified.

export interface ProjectScopedSearchOptions {
  /** `uri.toString():line` of the peeked symbol's own declaration(s); a candidate is
   *  kept only if its definition resolves to one of these. */
  identityKeys: Set<string>;
  /** The identifier to scan for (the type name or the method name). */
  symbolName: string;
  isCancelled: () => boolean;
  onProgress: (p: ProgressUpdate) => void;
  /** Safety cap on candidate definition-provider calls (default 4000). */
  maxCandidates?: number;
  /** When set, scan only this file instead of the whole workspace (current-class peek). */
  restrictToFile?: vscode.Uri;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idKey = (l: vscode.Location) => `${l.uri.toString()}:${l.range.start.line}`;

export async function searchProjectReferences(
  opts: ProjectScopedSearchOptions
): Promise<vscode.Location[]> {
  const { identityKeys, symbolName, isCancelled, onProgress } = opts;
  const maxCandidates = opts.maxCandidates ?? 4000;
  if (identityKeys.size === 0) { return []; }

  const files = opts.restrictToFile
    ? [opts.restrictToFile]
    : await vscode.workspace.findFiles('**/*.java');
  const word = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'g');
  const results: vscode.Location[] = [];
  const seen = new Set<string>();
  let calls = 0;
  let done = 0;

  onProgress({ label: 'Searching project files…', done: 0, total: files.length });

  for (const file of files) {
    if (isCancelled() || calls >= maxCandidates) { break; }
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(file);
    } catch {
      onProgress({ label: 'Searching project files…', done: ++done, total: files.length });
      continue;
    }
    const text = doc.getText();
    word.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = word.exec(text)) !== null) {
      if (isCancelled() || calls >= maxCandidates) { break; }
      const pos = doc.positionAt(m.index);
      calls++;
      let defs: vscode.Location[];
      try {
        defs = (await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider', file, pos
        )) ?? [];
      } catch {
        defs = [];
      }
      if (defs.some(d => identityKeys.has(idKey(d)))) {
        // Record at the start of the line so downstream dedupe (`uri:line`) collapses
        // multiple occurrences on one line, matching the rest of the pipeline.
        const k = `${file.toString()}:${pos.line}`;
        if (!seen.has(k)) {
          seen.add(k);
          results.push(new vscode.Location(file, new vscode.Position(pos.line, pos.character)));
        }
      }
    }
    onProgress({ label: 'Searching project files…', done: ++done, total: files.length });
  }

  return results;
}
