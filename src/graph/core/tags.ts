// Well-known role tags. Rules may emit other strings, but these are the ones the
// graph view and peek view know how to group/filter by.
export const Tags = {
  Dto: 'dto',
  Enum: 'enum',
  Entity: 'entity',
  Repository: 'repository',
  Service: 'service',
  Controller: 'controller',
  EventHandler: 'eventHandler',
  Abstract: 'abstract',
  Config: 'config',
  Test: 'test',
} as const;

export type KnownTag = (typeof Tags)[keyof typeof Tags];
