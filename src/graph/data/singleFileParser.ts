// Parses a single source file using the registered tree-sitter provider.
// Reuses the existing parse cache so repeated calls for the same content are free.

import * as vscode from 'vscode';
import { ParsedType } from '../core/types';
import { providerForUri } from '../lang/registry';
import { parseCached } from '../core/cache';

export async function parseSingleFile(uri: vscode.Uri): Promise<ParsedType[]> {
  const provider = providerForUri(uri.toString());
  if (!provider) { return []; }
  await provider.init();  // no-op once the wasm grammar is loaded
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  return parseCached(uri.toString(), text, provider.parse);
}

export async function readFileText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}
