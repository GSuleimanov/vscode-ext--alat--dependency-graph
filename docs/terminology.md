# Codenav Graph Terminology

Shared vocabulary for the Project Graph — used in code comments, docs, and commit
messages. When in doubt, use these words.

## Nodes

A **node** is a graph element (one class). Nodes are grouped into concentric
rings around the current focus:

| Term              | Definition                                                        | Visibility                    |
| ----------------- | ----------------------------------------------------------------- | ----------------------------- |
| **Selected node** | The node currently in focus — the centre the graph is built around. | Opaque, highlighted.          |
| **Active nodes**  | Nodes directly connected to the selected node (one hop).          | Opaque.                       |
| **Inactive nodes**| Nodes connected to active nodes (two hops from selection).        | Dimmed / transparent.         |
| **Shadow nodes**  | Connections of inactive nodes (three hops). Not drawn by default. | Hidden until their owner is hovered. |

A hop is one edge. The selected node sits at the centre; each ring is one edge
farther out. Shadow nodes give the graph "+2 depth" of precision without
cluttering the default view — they only fade in when you hover the inactive node
they hang off.

## Edges (relationships)

Edges are directed: `A → B` means **A depends on / calls B**. Read from either
end of an edge:

- **Dependencies** (short **d**) — what a node *uses*: the nodes it points to.
- **Callers** (short **c**) — who *uses* a node: the nodes pointing at it.

### Depth notation

Prefix the count with a number to mean "this many hops away":

- **1d** — direct dependency (a node the focus uses directly).
- **2d** — a dependency of a dependency; **3d** — three hops down the dependency
  chain, and so on.
- **1c** — direct caller; **2c** — a caller's caller; etc.

So "show 2d" means expand two levels of dependencies; "the 1c ring" is the set of
direct callers.

## Mapping to the code

The terms above map onto the `tier` field each node carries in
[`src/commands/graphView.ts`](../src/commands/graphView.ts):

| Terminology              | `tier` value              |
| ------------------------ | ------------------------- |
| Selected node + active   | `active`                  |
| Inactive nodes           | `inactive`                |
| Shadow nodes             | `shadow`                  |

(The selected node is the `active`-tier node whose id equals `activeId`.)

See [`graph.md`](graph.md) for how nodes are laid out once classified.
