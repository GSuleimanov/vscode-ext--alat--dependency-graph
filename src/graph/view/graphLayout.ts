// Pure row-based layout for the focused graph view. No VSCode imports — fully unit-testable.
//
// The graph is three horizontal rows: callers (above) → center+siblings (middle) → dependencies (below).
// Nodes within each row are evenly spread, horizontally centered around x=0.

import { FocusedGraphNode } from '../data/focusedGraphTypes';

export const ROW_Y: Record<FocusedGraphNode['role'], number> = {
  caller:     -240,
  sibling:       0,
  center:        0,
  dependency:  240,
};

const X_GAP = 170;

export interface LayoutNode extends FocusedGraphNode {
  x: number;
  y: number;
}

export function layoutNodes(nodes: FocusedGraphNode[]): LayoutNode[] {
  // Group by role; center and siblings share a row but center is always placed in the middle.
  const callers     = nodes.filter(n => n.role === 'caller');
  const deps        = nodes.filter(n => n.role === 'dependency');
  const centerNode  = nodes.find(n => n.role === 'center');
  const siblings    = nodes.filter(n => n.role === 'sibling');

  const out: LayoutNode[] = [];

  function placeRow(group: FocusedGraphNode[], y: number): void {
    const total = group.length;
    group.forEach((n, i) => {
      const x = total === 1 ? 0 : -(total - 1) * X_GAP / 2 + i * X_GAP;
      out.push({ ...n, x, y });
    });
  }

  placeRow(callers, ROW_Y.caller);
  placeRow(deps,    ROW_Y.dependency);

  // Center row: siblings split left/right with center node in the middle.
  if (centerNode) {
    const half = Math.floor(siblings.length / 2);
    const leftSibs  = siblings.slice(0, half);
    const rightSibs = siblings.slice(half);
    const centerRow = [...leftSibs, centerNode, ...rightSibs];
    placeRow(centerRow, ROW_Y.center);
  }

  return out;
}
