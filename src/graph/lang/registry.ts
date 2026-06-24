import { ParsedType, Tag } from '../core/types';

// Per-file context handed to role rules so they can cheaply gate themselves
// (e.g. skip lombok rules when the file imports nothing from lombok).
export interface FileContext {
  uri: string;
  text: string;
  imports: Set<string>;
  lang: string;
}

// A composable role classifier. Multiple rules run per file and each contributes
// additive tags — frameworks are NOT mutually exclusive (a Java class can be
// @Entity + @Data at once), so rules union rather than select.
export interface RoleRule {
  id: string;
  enabled(ctx: FileContext): boolean;
  tags(type: ParsedType, ctx: FileContext): Tag[];
}

// A language strategy: selected by file extension. Parsing is encapsulated here
// (tree-sitter grammar per language), swappable without touching callers.
export interface LanguageProvider {
  id: string;
  extensions: string[];   // ['.java']
  include: string;        // vscode.workspace.findFiles include glob
  exclude: string;        // findFiles exclude glob
  // One-time async grammar load. Must be awaited before parse().
  init(): Promise<void>;
  parse(text: string, uri: string): ParsedType[];
}

const providers: LanguageProvider[] = [];

export function registerProvider(p: LanguageProvider): void {
  if (!providers.some(x => x.id === p.id)) { providers.push(p); }
}

export function allProviders(): LanguageProvider[] {
  return providers.slice();
}

export function providerForUri(uri: string): LanguageProvider | undefined {
  const lower = uri.toLowerCase();
  return providers.find(p => p.extensions.some(ext => lower.endsWith(ext)));
}

/**
 * Apply a language's role rules to its parsed types, mutating each type's `tags`
 * to the union of all enabled rules' contributions. Shared by every provider.
 */
export function applyRules(types: ParsedType[], rules: RoleRule[], ctx: FileContext): ParsedType[] {
  const active = rules.filter(r => r.enabled(ctx));
  for (const type of types) {
    const tags = new Set(type.tags ?? []);
    for (const rule of active) {
      for (const tag of rule.tags(type, ctx)) { tags.add(tag); }
    }
    type.tags = [...tags];
  }
  return types;
}
