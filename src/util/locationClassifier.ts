import * as vscode from 'vscode';

export type LocationKind =
  'typeDefinition' | 'interface' | 'definition' | 'implementation' | 'reference' | 'test';

export interface ClassifiedLocation {
  location: vscode.Location;
  kind: LocationKind;
}

export function classifyLocations(
  locations: vscode.Location[],
  typeDefLocs: vscode.Location[],
  defLocs: vscode.Location[],
  implLocs: vscode.Location[],
  interfaceLocs: vscode.Location[] = []
): ClassifiedLocation[] {
  const locKey = (l: vscode.Location) => `${l.uri.fsPath}:${l.range.start.line}`;
  const typeDefKeys = new Set(typeDefLocs.map(locKey));
  const interfaceKeys = new Set(interfaceLocs.map(locKey));
  const defKeys = new Set(defLocs.map(locKey));
  const implKeys = new Set(implLocs.map(locKey));

  return locations.map(loc => {
    const key = locKey(loc);
    const kind: LocationKind =
      typeDefKeys.has(key)   ? 'typeDefinition' :
      interfaceKeys.has(key) ? 'interface' :
      defKeys.has(key)       ? 'definition' :
      implKeys.has(key)      ? 'implementation' :
                               'reference';
    return { location: loc, kind };
  });
}
