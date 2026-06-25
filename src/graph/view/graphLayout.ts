// Pure row-based layout for the focused graph view. No VSCode imports — fully unit-testable.
//
// Five horizontal rows (traverse rows only appear when Traverse is active):
//   caller2 (−480) → callers (−240) → center+siblings (0) → dependencies (+240) → dependency2 (+480)

import { FocusedGraphNode } from '../data/focusedGraphTypes';

export const ROW_Y: Record<FocusedGraphNode['role'], number> = {
  caller2:    -480,
  caller:     -240,
  sibling:       0,
  center:        0,
  dependency:  240,
  dependency2: 480,
};

const X_GAP = 170;

export interface LayoutNode extends FocusedGraphNode {
  x: number;
  y: number;
}

export function layoutNodes(nodes: FocusedGraphNode[]): LayoutNode[] {
  const callers2   = nodes.filter(n => n.role === 'caller2');
  const callers    = nodes.filter(n => n.role === 'caller');
  const deps       = nodes.filter(n => n.role === 'dependency');
  const deps2      = nodes.filter(n => n.role === 'dependency2');
  const centerNode = nodes.find(n => n.role === 'center');
  const siblings   = nodes.filter(n => n.role === 'sibling');

  const out: LayoutNode[] = [];

  function placeRow(group: FocusedGraphNode[], y: number): void {
    const total = group.length;
    group.forEach((n, i) => {
      const x = total === 1 ? 0 : -(total - 1) * X_GAP / 2 + i * X_GAP;
      out.push({ ...n, x, y });
    });
  }

  placeRow(callers2, ROW_Y.caller2);
  placeRow(callers,  ROW_Y.caller);
  placeRow(deps,     ROW_Y.dependency);
  placeRow(deps2,    ROW_Y.dependency2);

  // Center row: siblings split left/right with center node in the middle.
  if (centerNode) {
    const half = Math.floor(siblings.length / 2);
    const centerRow = [...siblings.slice(0, half), centerNode, ...siblings.slice(half)];
    placeRow(centerRow, ROW_Y.center);
  }

  return out;
}
