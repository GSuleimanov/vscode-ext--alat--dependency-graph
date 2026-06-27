# Codenav Graph Layout

How Codenav positions classes in the Project Graph — and the established
computer-science it is built on.

## What it is, scientifically

The Project Graph uses **layered graph drawing** (a.k.a. **hierarchical graph
drawing**), the classic technique introduced by **Sugiyama, Tagawa & Toda
(1981)** and known as the **Sugiyama framework** — the same family behind
Graphviz `dot`, dagre, and ELK "layered".

A layered layout draws a directed graph so **edge direction reads consistently
down the page**: if `A → B` (A depends on / calls B), B is placed on a row
strictly below A. This turns a tangle of references into a readable hierarchy of
*who depends on whom*.

The step that decides **which row each element belongs to** is **layer
assignment** (equivalently **ranking** / **leveling**): assign each node an
integer *layer* so every edge points from a lower layer to a higher one.

## The pipeline (four phases)

### 1. Cycle removal (make it acyclic)
Layer assignment is only well-defined on a **DAG**, but call graphs contain
cycles. A DFS drops **back edges** (edges to a node still on the DFS stack) — the
standard **greedy cycle-removal** heuristic.

### 2. Layer assignment — *longest-path layering*
Each node's layer is the **longest path** reaching it from a source, computed by
one topological-order relaxation (Kahn's algorithm): for every edge `u → v`,
enforce `layer(v) ≥ layer(u) + 1` and take the max over all predecessors. This
makes the hierarchy *global* — a node sits below **every** node that reaches it,
so a four-deep chain occupies four rows. Layers are then **shifted so the
selected class is at layer 0** (callers above, dependencies below).

### 3. Crossing minimization — *the median heuristic*
Minimizing **edge crossings** is NP-hard, so we use the **median/barycenter
heuristic** (Eades & Wormald; Gansner et al.): reorder each layer by the median
position of each node's neighbours in the adjacent layer, sweeping down/up for
several iterations.

### 4. Coordinate assignment
`y = layer × row-height`. Horizontal positions come from an iterative
**priority/barycenter** pass (a lightweight cousin of **Brandes–Köpf**): pull each
node toward the average x of its neighbours, then enforce a minimum per-row gap.
Codenav makes this **tier-aware** — the active subgraph is packed tight and
centred, faded context nodes fan out to the sides.

## One-line pitch

> Codenav lays out the dependency graph with a **Sugiyama-style layered
> algorithm**: it breaks cycles into a DAG, assigns each class a **layer via
> longest-path ranking** (so layout depth reflects true dependency depth),
> minimizes crossings with the **median heuristic**, and places coordinates with
> a tier-aware barycenter pass that keeps the selected element centred.

## Where it lives in the code

`layeredLayout()` in [`src/commands/graphView.ts`](../src/commands/graphView.ts),
phases labelled `1) … 4)`. It runs in the default *ephemeral* view; *persist*
mode uses an incremental force pass to keep accumulated nodes stable.

## References

- Sugiyama, Tagawa, Toda. *Methods for Visual Understanding of Hierarchical
  System Structures.* IEEE SMC, 1981. — the original framework.
- Gansner, Koutsofios, North, Vo. *A Technique for Drawing Directed Graphs.*
  IEEE TSE, 1993. — Graphviz `dot`; longest-path ranking + median ordering.
- Eades, Wormald. *Edge Crossings in Drawings of Bipartite Graphs.* Algorithmica,
  1994. — median crossing heuristic.
- Brandes, Köpf. *Fast and Simple Horizontal Coordinate Assignment.* Graph
  Drawing, 2001.
- Di Battista, Eades, Tamassia, Tollis. *Graph Drawing.* Prentice Hall, 1999. —
  standard textbook.
