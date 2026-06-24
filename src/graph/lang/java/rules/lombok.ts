import { RoleRule } from '../../registry';
import { Tags } from '../../../core/tags';

// Lombok value/data/builder annotations mark a class as a DTO-shaped value type.
export const lombokRule: RoleRule = {
  id: 'java/lombok',
  enabled: (ctx) => [...ctx.imports].some(i => i.startsWith('lombok')),
  tags(type) {
    const ann = new Set(type.annotations ?? []);
    return (ann.has('Data') || ann.has('Value') || ann.has('Builder')) ? [Tags.Dto] : [];
  },
};
