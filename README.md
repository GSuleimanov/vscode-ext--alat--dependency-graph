# Codenav

**See any codebase as a map, not a wall of files.**

Codenav turns your project into a living dependency graph that re-centres on
whatever you're looking at. Open a class and you instantly see *who calls it*,
*what it depends on*, *what it inherits from*, and *what sits beside it* — laid
out so the structure reads at a glance instead of being reconstructed in your
head, one Go-to-Definition at a time.

It's **language-agnostic by design** and renders in **milliseconds**, because of
how it's built.

---

## The idea: comprehension is a graph problem

A codebase isn't a list of files — it's a directed graph of types that depend on
each other. The trouble is that no single tool sees that graph well:

- **Static parsers** (tree-sitter) read one file perfectly and instantly, but
  know nothing about the rest of the project.
- **Language servers** (LSP) hold a project-wide semantic index — every caller,
  every implementation — but answering a query is a round-trip, and asking for
  *everything* is slow.

Codenav combines both, using each for what it's best at, then draws the result
with the established science of **hierarchical graph drawing**. The outcome is a
view that is correct across the whole project yet appears the instant you click.

---

## What you see

Focus a class and the graph centres on it, with relationships flowing top-to-bottom:

```
        [ CallerA ]    [ CallerB ]        ← who uses this class      (LSP)
                 ↘        ↙
              [  Focused Class  ]          ← the centre               (tree-sitter)
                 ↙        ↘
        [ Dependency ]  [ Parent ]         ← what it uses / inherits  (tree-sitter + LSP)
```

The view is organised as **concentric rings** of relevance around the focus:

| Ring | What it is | How it's drawn |
|---|---|---|
| **Focused** | The class you selected — the centre everything is built around. | Opaque, highlighted. |
| **Active** | Its direct neighbours, one hop away: callers, dependencies, parents, siblings. | Opaque. |
| **Inactive** | Two hops out — the neighbours of your neighbours, for context. | Dimmed. |
| **Shadow** | Three hops out. Hidden until you hover the node they hang off. | Fade in on demand. |

This gives you *depth without clutter*: the immediate neighbourhood is sharp, the
surrounding topology is faintly visible, and the next layer is one hover away.

**Edges are directed and meaningful** — `A → B` means *A depends on / calls B* —
so the graph distinguishes "what this uses" (dependencies, below) from "what uses
this" (callers, above), plus inheritance (`extends` / `implements`) and sibling
implementations of a shared parent.

---

## How it's built: a hybrid engine

The graph never scans your workspace on load. It reads exactly **one file**
synchronously, then asks the already-running language server for the rest.

| Data | Source | Why |
|---|---|---|
| Focused class + its field/inheritance types | **tree-sitter** (static parse) | A single-file parse is ~5 ms — no LSP round-trip, structurally exact. |
| Callers — who references this class | **LSP** `executeReferenceProvider` | The project-wide index is already maintained; correct across every file without scanning. |
| Siblings — other implementations of the parent | **LSP** `executeImplementationProvider` | The language server already knows the full type hierarchy. |

Two consequences fall out of this design:

- **Progressive rendering.** Results stream in stages. The centre and its
  dependencies appear in milliseconds from tree-sitter; callers and siblings fill
  in as the language server responds. You're never staring at a spinner.
- **It settles and stays settled.** Every expansion is memoized in a cache split
  along the same seam it's computed: the *intrinsic* half (centre + dependencies)
  is keyed on the file's own content hash, the *extrinsic* half (callers +
  siblings) on a workspace epoch bumped on save. A node expanded once is replayed
  from cache — no LSP — so a large graph stabilises after one pass and clicking
  the same node always yields the same neighbourhood.

---

## How it's drawn: the Sugiyama framework

Position carries meaning. Codenav lays the graph out with **layered (hierarchical)
graph drawing** — the classic **Sugiyama framework**, the same family behind
Graphviz `dot`, dagre and ELK. Four phases:

1. **Cycle removal** — call graphs have cycles, but layering needs a DAG, so a DFS
   drops back edges (greedy cycle removal).
2. **Layer assignment** — *longest-path ranking*: each class sits below **every**
   class that reaches it, so a four-deep chain occupies four rows and **layout
   depth reflects true dependency depth**. Layers are shifted so the focus is at
   row 0 — callers above, dependencies below.
3. **Crossing minimization** — the **median heuristic** reorders each row by the
   median position of its neighbours, sweeping until crossings settle (the full
   problem is NP-hard).
4. **Coordinate assignment** — a tier-aware barycenter pass pulls each node toward
   its neighbours' average, packs the active subgraph tight and centred, and fans
   faded context nodes out to the sides.

The full algorithm and its references are in [docs/graph.md](docs/graph.md); the
vocabulary (focused / active / inactive / shadow, the `Nd`/`Nc` notation) is in
[docs/terminology.md](docs/terminology.md).

---

## Why an engineer wants this

- **Onboarding a new area.** Drop into an unfamiliar class and read its blast
  radius — who depends on it, what it leans on — without a dozen Find-All-References
  detours.
- **Scoping a change.** Before you touch a class, the callers ring *is* your impact
  analysis: everything above the focus is what might break.
- **Tracing a path.** Single-click to glide from node to node, following a
  dependency chain or a caller chain across files while the layout keeps your place.
- **Spotting structure smells.** Long chains, dense caller fans, and unexpected
  cycles are visible as shapes — the things that are hard to feel from text.
- **Understanding a hierarchy.** Inheritance edges and sibling implementations show
  a type's place in its family at a glance.

---

## Using it

Run **`Codenav: Open Project Graph`** from the Command Palette to open the graph as
an editor tab, beside your code. It centres on the active class and follows you as
you move.

| Action | Result |
| --- | --- |
| **Single-click** a node | Focus it — the camera glides over and the file opens in a **preview** tab, so you can keep exploring without losing your place. |
| **Double-click** a node | Open the file for real (pinned tab, focus moves to the editor). |
| **Hover** a node | Switch context to it — its connections light up while everything else dims, and its shadow ring fades in. |

Re-centring is animated and stable: pick another class and shared nodes stay put
while the view re-flows around the new focus.

---

## Languages

Codenav is language-agnostic through a pluggable provider registry — each language
contributes a tree-sitter grammar and a set of role rules, with no changes to the
graph engine or layout. **Java** (including Spring/Lombok role detection) and
**Python** ship today; adding a language is adding a provider.

## Requirements

- VSCode `^1.64.0`
- A language server for your language (e.g. the
  [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java)
  extension) for the caller and implementation queries.

## Development

```bash
npm install
npm run build       # production bundle → dist/extension.js
npm run dev         # watch mode
npm run compile     # type-check only (tsc --noEmit)
npm test            # unit tests (node:test + ts-node)
```

## License

[Apache-2.0](LICENSE)
</content>
</invoke>
