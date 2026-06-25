// Pure types for the focused graph view. No VSCode imports — safe to import anywhere.

export type NodeRole = 'center' | 'dependency' | 'caller' | 'sibling' | 'caller2' | 'dependency2';
export type FocusedEdgeKind = 'extends' | 'implements' | 'uses' | 'calls';

export interface FocusedGraphNode {
  id: string;        // `${uri}:${line}` — stable across reloads
  name: string;      // simple class name
  uri: string;       // source file URI string
  line: number;      // 0-based line of the type declaration
  kind: 'class' | 'interface' | 'enum';
  tags: string[];    // role tags from tree-sitter parse (controller, service, etc.)
  role: NodeRole;
}

export interface FocusedGraphEdge {
  from: string;   // FocusedGraphNode.id
  to: string;     // FocusedGraphNode.id
  kind: FocusedEdgeKind;
}

// Progressive update emitted by focusedGraphBuilder — one per stage.
// Base stages arrive in order: center → dependencies → callers → siblings.
// Traverse stages (optional, on demand): traverse-callers → traverse-deps.
export type GraphStageUpdate =
  | { stage: 'center';           node: FocusedGraphNode }
  | { stage: 'dependencies';     nodes: FocusedGraphNode[]; edges: FocusedGraphEdge[] }
  | { stage: 'callers';          nodes: FocusedGraphNode[]; edges: FocusedGraphEdge[] }
  | { stage: 'siblings';         nodes: FocusedGraphNode[]; edges: FocusedGraphEdge[] }
  | { stage: 'traverse-callers'; nodes: FocusedGraphNode[]; edges: FocusedGraphEdge[] }
  | { stage: 'traverse-deps';    nodes: FocusedGraphNode[]; edges: FocusedGraphEdge[] };

export type StageCallback = (update: GraphStageUpdate) => void;
