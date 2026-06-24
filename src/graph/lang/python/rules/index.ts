import { RoleRule } from '../../registry';
import { pyGeneralRule } from './general';
import { pydanticRule } from './pydantic';

export const pythonRules: RoleRule[] = [pyGeneralRule, pydanticRule];
