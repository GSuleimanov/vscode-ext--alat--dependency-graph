// Public surface for the graph subsystem.
export * from './core/types';
export * from './core/tags';
export { buildGraph } from './core/buildGraph';
export { parseCached, clearParseCache } from './core/cache';
export { allProviders, providerForUri, type LanguageProvider } from './lang/registry';
export { parseJavaSource, javaProvider } from './lang/java/provider';
export { parsePythonSource, pythonProvider } from './lang/python/provider';
export { makeProvider, type LangSpec } from './lang/generic/provider';
export { genericSpecs } from './lang/generic/specs';

// Focused graph types (no VSCode — safe for unit tests). The VSCode-dependent
// modules (focusedGraphBuilder, singleFileParser) are imported directly by
// graphView.ts, not re-exported here. Node layout now lives in the webview, which
// owns coordinates as a persistent, accumulating map.
export * from './data/focusedGraphTypes';

// Side-effect import: registers all language providers.
import './lang';
