import { registerProvider } from './registry';
import { javaProvider } from './java/provider';
import { pythonProvider } from './python/provider';
import { makeProvider } from './generic/provider';
import { genericSpecs } from './generic/specs';

// Register every language strategy. Import this module for its side effects
// before using allProviders()/providerForUri(). Java and Python keep dedicated
// providers (nested-type qualification + framework sugar); every other language
// is a declarative spec run through the shared query-driven generic provider.
// Adding a language is one spec in generic/specs.ts — no parser or caller changes.
registerProvider(javaProvider);
registerProvider(pythonProvider);
for (const spec of genericSpecs) { registerProvider(makeProvider(spec)); }

export { initProviders } from './registry';
