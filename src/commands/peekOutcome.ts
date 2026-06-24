import * as vscode from 'vscode';
import * as path from 'path';
import { classifyLocations, LocationKind } from '../util/locationClassifier';

// A serialisable summary of what a peek produced, so tests (and any caller) can assert
// behaviour without scraping the webview. Reflects the core decisions — scope, guardrail,
// classification, receiver-scoping, expansion — before the view's import/test filtering.

export type PeekStatus = 'results' | 'refused' | 'empty' | 'cancelled' | 'noEditor';

export interface OutcomeItem {
  /** Path relative to the workspace root (or absolute/uri for out-of-workspace locations). */
  path: string;
  /** Zero-based line. */
  line: number;
}

export type PeekSections = Partial<Record<LocationKind, OutcomeItem[]>>;

export interface PeekOutcome {
  status: PeekStatus;
  symbolName?: string;
  message?: string;
  sections?: PeekSections;
}

export interface ResultsInput {
  symbolName: string;
  rawLocations: vscode.Location[];
  typeDefLocations: vscode.Location[];
  defLocations: vscode.Location[];
  implLocations: vscode.Location[];
  interfaceLocations: vscode.Location[];
}

function relPath(l: vscode.Location, wsRoot: string): string {
  if (l.uri.scheme !== 'file') { return l.uri.toString(); }
  const rel = wsRoot ? path.relative(wsRoot, l.uri.fsPath) : l.uri.fsPath;
  return rel && !rel.startsWith('..') ? rel : l.uri.fsPath;
}

/** Builds the grouped outcome the way the panel classifies it (minus import/test filtering). */
export function buildResultsOutcome(input: ResultsInput, wsRoot: string): PeekOutcome {
  const key = (l: vscode.Location) => `${l.uri.fsPath}:${l.range.start.line}`;

  // Dedupe references and merge in structural locations (so every section renders),
  // exactly as the panel does before classifying.
  const merged: vscode.Location[] = [];
  const added = new Set<string>();
  const push = (l: vscode.Location) => { const k = key(l); if (!added.has(k)) { added.add(k); merged.push(l); } };
  input.rawLocations.forEach(push);
  [...input.typeDefLocations, ...input.interfaceLocations, ...input.defLocations, ...input.implLocations].forEach(push);

  const classified = classifyLocations(
    merged,
    input.typeDefLocations, input.defLocations, input.implLocations, input.interfaceLocations
  );

  const sections: PeekSections = {};
  for (const { location, kind } of classified) {
    (sections[kind] ??= []).push({ path: relPath(location, wsRoot), line: location.range.start.line });
  }
  return { status: 'results', symbolName: input.symbolName, sections };
}
