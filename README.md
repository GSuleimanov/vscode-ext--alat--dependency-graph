# Dependency Graph

A codebase is not just a list of files — it's a directed graph of types that depend on
each other. The trouble is that for me personally there is no single tool representing that graph well. 
I build it for myself, and polished it to be used by fellow engineers.
It's **language-agnostic by design** and renders in **milliseconds**, because of
how it's built.

## Problem #1: parsing

There are several tools that allows to show connections between components, each with their pros and cons. 
Here I used hybrid approach to take best of each:

- **Static parsers** (tree-sitter) read one file perfectly and instantly, but
  know nothing about the rest of the project.
- **Language servers** (LSP) hold a project-wide semantic index — every caller,
  every implementation — but answering a query is a round-trip, and asking for anything is slow.

The graph never scans your workspace on load. It reads exactly **one file**
synchronously, then asks the LSP for the heavy part. The result is memoized, so each time you shift focus - the missing part is fetched and cached.

Two consequences fall out of this approach:

- **Progressive rendering.** Results stream in stages. The centre and its
  dependencies appear in milliseconds from tree-sitter; callers and siblings fill
  in as the language server responds.
- **It settles and stays settled.** Every node hop is memoized.
  - the *intrinsic* half (centre + dependencies) is keyed on the file's own content hash;
  - the *extrinsic* half (callers + siblings) on a workspace epoch bumped on save. 
  A node expanded once is replayed from cache — no LSP — so a large graph stabilises after one pass and clicking
  the same node always yields the same neighbourhood.

---

## Problem #2: visualization

Visualizing a graph isn't difficult, but making sense of it is. There are many possibilities, but I needed a balance between functionality and usability. After many iterations and research, I settled on a structure I'm happy with.

Focus a class and the graph centres on it, with relationships flowing top-to-bottom:

```
          [ CallerA ]    [ CallerB ]      ← who uses this class      (LSP)
                 ↘          ↙
              [  Focused Class  ]         ← the centre               (tree-sitter)
                 ↙          ↘
         [ Dependency ]  [ Parent ]       ← what it uses / inherits  (tree-sitter + LSP)
```

The view is organised as **rings** of relevance around the focus:

| Ring | What it is | How it's drawn |
|---|---|---|
| **Focused** | The class you selected — the centre everything is built around. | Opaque, highlighted. |
| **Active** | Its direct neighbours, one hop away: callers, dependencies, parents, siblings. | Opaque. |
| **Inactive** | Two hops out — the neighbours of your neighbours, for context. | Dimmed. |
| **Shadow** | Three hops out. Hidden until you hover the node they hang off. | Fade in when you focus inactive nodes |

This gives you depth, but no clutter: 

- the immediate neighbourhood is highlighted with connections shown
- the surrounding topology is faintly visible
- and the next layer is hover away

For the basis of the visual language was picked **Sugiyama framework**, with a few adjustments:

1. **Cycle removal** — call graphs have cycles, but layering needs a DAG, so a DFS drops back edges (greedy cycle removal).
2. **Layer assignment** — *longest-path ranking*: each class sits below **every** class that reaches it, so a four-deep chain occupies four rows and **layout depth reflects true dependency depth**. Layers are shifted relative to the selected node - callers above, dependencies below.
3. **Crossing minimization** — the **median heuristic** reorders each row by the median position of its neighbours, sweeping until crossings settle.
4. **Coordinate assignment** — pulls each node toward its neighbours' average, packs the active subgraph tight and centred, and fans faded context nodes out to the sides.

The full algorithm and its references are in [docs/graph.md](docs/graph.md); the
vocabulary (focused / active / inactive / shadow, the `Nd`/`Nc` notation) is in
[docs/terminology.md](docs/terminology.md).

---

## Why an engineer might find this useful

- **Onboarding a new area.** Checking out an unfamiliar class and read its blast
  radius — who depends on it, what it's usages just by a glance on the graph.
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

| Action | Result |
| --- | --- |
| **Single-click** a node | Focus it — the camera glides over and the file opens in a **preview** tab, so you can keep exploring without losing your place. |
| **Double-click** a node | Open the file for real (pinned tab, focus moves to the editor). |
| **Hover** a node | Switch context to it — its connections light up while everything else dims, and its shadow ring fades in. |

Re-centring is animated and stable: pick another class and shared nodes stay put
while the view re-flows around the new focus.

---

## Languages

The extension is language-agnostic through a pluggable provider registry — each language
contributes a tree-sitter grammar and a set of role rules, with no changes to the
graph engine or layout.

## Requirements

- VSCode `^1.64.0`
- A language server for your language.

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
