// Public surface for the graph subsystem.
export * from './core/types';
export * from './core/tags';
export { buildGraph } from './core/buildGraph';
export { parseCached, clearParseCache } from './core/cache';
export { allProviders, providerForUri, type LanguageProvider } from './lang/registry';
export { parseJavaSource, javaProvider } from './lang/java/provider';
export { parsePythonSource, pythonProvider } from './lang/python/provider';

// Side-effect import: registers all language providers.
import './lang';
