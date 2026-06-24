import { ParsedType } from './types';

// Per-file parse cache keyed by uri, invalidated when the file content hash
// changes. Keeps re-renders cheap on large projects (feature 03: 200+ classes).
const store = new Map<string, { hash: number; types: ParsedType[] }>();

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

export function parseCached(
  uri: string,
  text: string,
  parse: (text: string, uri: string) => ParsedType[]
): ParsedType[] {
  const h = hash(text);
  const hit = store.get(uri);
  if (hit && hit.hash === h) { return hit.types; }
  const types = parse(text, uri);
  store.set(uri, { hash: h, types });
  return types;
}

export function clearParseCache(): void {
  store.clear();
}
