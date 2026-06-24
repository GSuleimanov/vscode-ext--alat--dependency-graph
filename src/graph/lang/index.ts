import { registerProvider } from './registry';
import { javaProvider } from './java/provider';
import { pythonProvider } from './python/provider';

// Register every language strategy. Import this module for its side effects
// before using allProviders()/providerForUri().
registerProvider(javaProvider);
registerProvider(pythonProvider);
