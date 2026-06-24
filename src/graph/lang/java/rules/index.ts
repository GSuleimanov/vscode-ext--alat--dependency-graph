import { RoleRule } from '../../registry';
import { standardRule } from './standard';
import { jakartaRule } from './jakarta';
import { springRule } from './spring';
import { lombokRule } from './lombok';
import { eventHandlerRule } from './events';

// All Java role rules, run in order; each contributes additive tags. Add a new
// framework by dropping a rule file here — no parser or core changes needed.
export const javaRules: RoleRule[] = [standardRule, jakartaRule, springRule, lombokRule, eventHandlerRule];
