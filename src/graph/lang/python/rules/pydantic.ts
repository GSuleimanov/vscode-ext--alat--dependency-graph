import { RoleRule } from '../../registry';
import { Tags } from '../../../core/tags';

// Pydantic models (subclasses of BaseModel) are DTO-shaped. Gated on a pydantic
// import in the file.
export const pydanticRule: RoleRule = {
  id: 'python/pydantic',
  enabled: (ctx) => [...ctx.imports].some(i => i === 'pydantic' || i.startsWith('pydantic.')),
  tags(type) {
    return type.extendsNames.includes('BaseModel') ? [Tags.Dto] : [];
  },
};
