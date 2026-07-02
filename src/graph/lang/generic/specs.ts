import { LangSpec } from './provider';

// Shared exclude for source-tree languages.
const NODE_EXCLUDE = '**/{node_modules,dist,out,build,.git,bin,obj,vendor,coverage}/**';

// ---- TypeScript / TSX -------------------------------------------------------
// .ts and .tsx use sibling grammars with identical node types, so one query
// serves both. `uses` captures every type_identifier and lets the generic core
// filter out the declaration's own name and its supertypes.
const TS_QUERY = `
  (class_declaration name: (type_identifier) @name) @def.class
  (interface_declaration name: (type_identifier) @name) @def.interface
  (enum_declaration name: (identifier) @name) @def.enum

  (extends_clause value: [(identifier) (member_expression) (generic_type)] @extends)
  (extends_type_clause [(type_identifier) (generic_type)] @extends)
  (implements_clause [(type_identifier) (generic_type)] @implements)

  ((type_identifier) @uses)

  (decorator (identifier) @annotation)
  (decorator (call_expression function: [(identifier) (member_expression)] @annotation))
`;

const TS_BUILTINS = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'object', 'symbol', 'bigint',
  'Array', 'ReadonlyArray', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Record', 'Partial',
  'Readonly', 'Pick', 'Omit', 'Date', 'RegExp', 'Error', 'Function', 'Object', 'String', 'Number',
  'Boolean', 'Symbol',
]);

export const typescriptSpec: LangSpec = {
  id: 'typescript', extensions: ['.ts', '.mts', '.cts'],
  wasmFile: 'tree-sitter-typescript.wasm',
  include: '**/*.{ts,mts,cts}', exclude: '**/{node_modules,dist,out,build,.git,bin,obj,vendor,coverage}/**,**/*.d.ts',
  query: TS_QUERY, builtins: TS_BUILTINS,
};

export const tsxSpec: LangSpec = {
  id: 'tsx', extensions: ['.tsx'],
  wasmFile: 'tree-sitter-tsx.wasm',
  include: '**/*.tsx', exclude: NODE_EXCLUDE,
  query: TS_QUERY, builtins: TS_BUILTINS,
};

// ---- JavaScript / JSX -------------------------------------------------------
// No type annotations, so dependency edges come from `new X()` constructor calls.
export const javascriptSpec: LangSpec = {
  id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  wasmFile: 'tree-sitter-javascript.wasm',
  include: '**/*.{js,jsx,mjs,cjs}', exclude: NODE_EXCLUDE,
  query: `
    (class_declaration name: (identifier) @name) @def.class
    (class_heritage [(identifier) (member_expression)] @extends)
    (new_expression constructor: [(identifier) (member_expression)] @uses)
    (decorator (identifier) @annotation)
    (decorator (call_expression function: [(identifier) (member_expression)] @annotation))
  `,
  builtins: new Set([
    'Array', 'Object', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
    'String', 'Number', 'Boolean', 'Symbol', 'Function', 'Proxy', 'JSON', 'Math',
  ]),
};

// ---- Go ---------------------------------------------------------------------
// Structs → "class", interfaces → "interface". Go inheritance is structural, so
// there are no extends/implements edges; dependency edges come from field types.
export const goSpec: LangSpec = {
  id: 'go', extensions: ['.go'],
  wasmFile: 'tree-sitter-go.wasm',
  include: '**/*.go', exclude: NODE_EXCLUDE,
  query: `
    (type_spec name: (type_identifier) @name type: (struct_type)) @def.class
    (type_spec name: (type_identifier) @name type: (interface_type)) @def.interface
    (field_declaration type: (type_identifier) @uses)
    (field_declaration type: (qualified_type name: (type_identifier) @uses))
    (field_declaration type: (pointer_type (type_identifier) @uses))
    (field_declaration type: (pointer_type (qualified_type name: (type_identifier) @uses)))
    (composite_literal type: (type_identifier) @uses)
    (composite_literal type: (qualified_type name: (type_identifier) @uses))
    ((type_identifier) @uses)
    (package_clause (package_identifier) @package)
  `,
  builtins: new Set([
    'string', 'bool', 'error', 'byte', 'rune', 'int', 'int8', 'int16', 'int32', 'int64',
    'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'float32', 'float64',
    'complex64', 'complex128', 'any',
  ]),
};

// ---- C# ---------------------------------------------------------------------
// base_list mixes the base class and interfaces with no syntactic distinction,
// so all bases become `extends` edges. Type positions are captured explicitly to
// avoid pulling in method/variable identifiers.
const CS_TYPE = '[(identifier) (generic_name) (qualified_name)]';
export const csharpSpec: LangSpec = {
  id: 'csharp', extensions: ['.cs'],
  wasmFile: 'tree-sitter-c_sharp.wasm',
  include: '**/*.cs', exclude: NODE_EXCLUDE,
  query: `
    (class_declaration name: (identifier) @name) @def.class
    (interface_declaration name: (identifier) @name) @def.interface
    (enum_declaration name: (identifier) @name) @def.enum
    (base_list ${CS_TYPE} @extends)
    (variable_declaration type: ${CS_TYPE} @uses)
    (method_declaration type: ${CS_TYPE} @uses)
    (parameter type: ${CS_TYPE} @uses)
    (object_creation_expression type: ${CS_TYPE} @uses)
    (property_declaration type: ${CS_TYPE} @uses)
    (attribute name: [(identifier) (qualified_name)] @annotation)
    (namespace_declaration name: [(identifier) (qualified_name)] @package)
    (file_scoped_namespace_declaration name: [(identifier) (qualified_name)] @package)
  `,
  builtins: new Set([
    'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'byte', 'sbyte', 'string', 'bool', 'char',
    'double', 'float', 'decimal', 'object', 'void', 'var', 'dynamic', 'Task', 'List', 'Dictionary',
    'IEnumerable', 'IList', 'ICollection', 'String', 'Int32', 'Int64', 'Boolean', 'Object',
    'DateTime', 'Guid', 'Nullable',
  ]),
};

// ---- C++ --------------------------------------------------------------------
// `body:` on the class/struct/enum keeps a *definition* from matching a bare
// type reference (e.g. a `struct Foo foo;` member).
const CPP_BUILTINS = new Set([
  'int', 'char', 'bool', 'void', 'float', 'double', 'long', 'short', 'unsigned', 'signed',
  'size_t', 'string', 'wstring', 'auto', 'std',
]);
export const cppSpec: LangSpec = {
  id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
  wasmFile: 'tree-sitter-cpp.wasm',
  include: '**/*.{cpp,cc,cxx,hpp,hh,hxx}', exclude: NODE_EXCLUDE,
  query: `
    (class_specifier name: (type_identifier) @name body: (field_declaration_list)) @def.class
    (struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @def.class
    (enum_specifier name: (type_identifier) @name body: (enumerator_list)) @def.enum
    (base_class_clause (type_identifier) @extends)
    (field_declaration type: (type_identifier) @uses)
    (parameter_declaration type: (type_identifier) @uses)
    (namespace_definition name: (namespace_identifier) @package)
  `,
  builtins: CPP_BUILTINS,
};

// ---- C ----------------------------------------------------------------------
export const cSpec: LangSpec = {
  id: 'c', extensions: ['.c', '.h'],
  wasmFile: 'tree-sitter-c.wasm',
  include: '**/*.{c,h}', exclude: NODE_EXCLUDE,
  query: `
    (struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @def.class
    (enum_specifier name: (type_identifier) @name body: (enumerator_list)) @def.enum
    (field_declaration type: (struct_specifier name: (type_identifier) @uses))
    (field_declaration type: (type_identifier) @uses)
  `,
  builtins: new Set([
    'int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'size_t',
  ]),
};

export const genericSpecs: LangSpec[] = [
  typescriptSpec, tsxSpec, javascriptSpec, goSpec, csharpSpec, cppSpec, cSpec,
];
