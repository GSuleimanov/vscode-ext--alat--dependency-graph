import { registerProvider } from './registry';
import { javaProvider } from './java/provider';
import { pythonProvider } from './python/provider';

// Register every language strategy. Import this module for its side effects
// before using allProviders()/providerForUri(). Adding a new language is a single
// registerProvider() call here — no caller changes.
registerProvider(javaProvider);
registerProvider(pythonProvider);

export { initProviders } from './registry';
