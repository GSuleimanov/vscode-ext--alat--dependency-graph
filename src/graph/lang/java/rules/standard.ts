import { RoleRule } from '../../registry';
import { Tags } from '../../../core/tags';

// Standard-library / language-level roles: enums, and DTO-shaped names. Always
// enabled — no framework import required. (Records are tagged as DTOs by the
// parser at declaration time, since `record` collapses to kind 'class'.)
export const standardRule: RoleRule = {
  id: 'java/standard',
  enabled: () => true,
  tags(type) {
    const out: string[] = [];
    if (type.kind === 'enum') { out.push(Tags.Enum); }
    if (/(DTO|Dto|Request|Response|Payload|VO)$/.test(type.name)) { out.push(Tags.Dto); }
    return out;
  },
};
