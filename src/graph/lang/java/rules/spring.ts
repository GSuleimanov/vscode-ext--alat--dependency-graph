import { RoleRule } from '../../registry';
import { Tags } from '../../../core/tags';

// Spring stereotype annotations -> repository / service / controller / config
// roles. Gated on a springframework import in the file.
export const springRule: RoleRule = {
  id: 'java/spring',
  enabled: (ctx) => [...ctx.imports].some(i => i.startsWith('org.springframework')),
  tags(type) {
    const ann = new Set(type.annotations ?? []);
    const out: string[] = [];
    if (ann.has('Repository')) { out.push(Tags.Repository); }
    if (ann.has('Service') || ann.has('Component')) { out.push(Tags.Service); }
    if (ann.has('RestController') || ann.has('Controller')) { out.push(Tags.Controller); }
    if (ann.has('Configuration') || ann.has('SpringBootApplication')) { out.push(Tags.Config); }
    return out;
  },
};
