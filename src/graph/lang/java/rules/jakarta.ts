import { RoleRule } from '../../registry';
import { Tags } from '../../../core/tags';

// Jakarta / javax persistence annotations -> entity role. Gated on the file
// importing the relevant namespace so it never fires on unrelated code.
export const jakartaRule: RoleRule = {
  id: 'java/jakarta',
  enabled: (ctx) =>
    [...ctx.imports].some(i => i.startsWith('jakarta.') || i.startsWith('javax.')),
  tags(type) {
    const ann = new Set(type.annotations ?? []);
    return (ann.has('Entity') || ann.has('Embeddable') || ann.has('MappedSuperclass'))
      ? [Tags.Entity]
      : [];
  },
};
