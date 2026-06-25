// Public surface for the graph subsystem.
export * from './core/types';
export * from './core/tags';
export { buildGraph } from './core/buildGraph';
export { parseCached, clearParseCache } from './core/cache';
export { allProviders, providerForUri, type LanguageProvider } from './lang/registry';
export { parseJavaSource, javaProvider } from './lang/java/provider';
export { parsePythonSource, pythonProvider } from './lang/python/provider';

// Focused graph types and pure layout (no VSCode — safe for unit tests).
// The VSCode-dependent modules (focusedGraphBuilder, singleFileParser) are
// imported directly by graphView.ts, not re-exported here.
export * from './data/focusedGraphTypes';
export { layoutNodes, type LayoutNode, ROW_Y } from './view/graphLayout';

// Side-effect import: registers all language providers.
import './lang';
