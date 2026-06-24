import { RoleRule } from '../../registry';
import { Tags } from '../../../core/tags';

// Standard-library Python roles: enum subclasses and @dataclass value types.
// Always enabled — no third-party import required.
export const pyGeneralRule: RoleRule = {
  id: 'python/general',
  enabled: () => true,
  tags(type) {
    const out: string[] = [];
    if (type.extendsNames.some(b => /^(Enum|IntEnum|StrEnum|Flag|IntFlag)$/.test(b))) {
      out.push(Tags.Enum);
    }
    if ((type.annotations ?? []).includes('dataclass')) { out.push(Tags.Dto); }
    return out;
  },
};
