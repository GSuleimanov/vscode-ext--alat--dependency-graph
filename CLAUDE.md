# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # production bundle → dist/extension.js (esbuild, vscode external)
npm run dev         # watch mode build
npm run compile     # type-check only (tsc --noEmit), no output
npm test            # unit tests via Node built-in test runner (node:test + ts-node)
npm run cucumber    # Cucumber BDD scenarios (all steps currently pending)
```

Run a single test file:
```bash
node --require ts-node/register --test src/commands/__tests__/tieredGraphBuilder.test.ts
```

## Architecture

This is a VSCode extension (`src/extension.ts` is the entry point) that enhances code reference navigation and dependency-graph visualization. It is language-agnostic: each language is a `LanguageProvider` registered in `src/graph/lang/` (tree-sitter for parsing, the file's own VSCode language server for callers/references). The extension is bundled with esbuild — `vscode` is external and injected at runtime.

### Core data flow

1. **Activation** (`src/extension.ts`) — registers the `codenav.openGraph` command and awaits `initProviders()` (loads every registered language grammar), then signals readiness to the graph view. Readiness is provider-driven; no single language server is gated on. Callers/references are resolved per-file via whatever VSCode language server handles that file.

2. **Graph view** (`src/commands/graphView.ts`) — `GraphSideView` owns the webview panel and acts as a stateless build service: on active-editor change it tells the webview which file is current; the webview pans to it if already mapped or asks for a build otherwise. All rendering and layout live in the webview's inline `<script>`.

The graph build pipeline itself is documented under **Graph data flow & the tiered build** below.

### Key design constraints

- The webview owns the node map (coordinates, tiers) as a persistent, accumulating state across reloads.
- All keyboard/mouse interaction, layout, and drawing live in the inline `<script>` of `getHtml()` in `graphView.ts`.
- The pure, VSCode-free builders (`graph/data/tieredGraphBuilder.ts`, `graph/core/*`) are unit-tested with fake projects.

## Graph terminology

Shared vocabulary for the Project Graph — use these words in code, comments, and commits. Canonical reference: [`docs/terminology.md`](docs/terminology.md).

- **node** — a graph element (one class).
- **selected node** — the node currently in focus; the centre the graph is built around. (a.k.a. *focused*)
- **active nodes** — nodes directly connected to the selected node (one hop). Opaque.
- **inactive nodes** — nodes connected to active nodes (two hops). Dimmed.
- **shadow nodes** — connections of inactive nodes (three hops). The loaded frontier — not drawn until their owner is hovered.
- **dependencies** (short **d**) — what a node *uses* (edges it points to). Depth notation `Nd`: `1d` = direct dependency, `3d` = three hops down.
- **callers** (short **c**) — who *uses* a node (edges pointing at it). Depth notation `Nc`: `1c` = direct caller, `2c` = a caller's caller.

Edges are directed: `A → B` means **A depends on / calls B**.

### Graph data flow & the tiered build

- **Per-class expansion** (`src/graph/data/focusedGraphBuilder.ts`) — `buildFocusedGraph` expands one class, streaming `center → dependencies → callers → siblings` stages. tree-sitter for the centre + deps (instant, intrinsic); LSP for callers + siblings (project-wide, extrinsic). Memoized in `expansionCache.ts` (intrinsic keyed on file hash, extrinsic on workspace epoch).
- **Tiered orchestration** (`src/graph/data/tieredGraphBuilder.ts`) — `buildTieredGraph` walks three expansion passes (selected → active ring → inactive ring) using an injected `expand`, classifying each node into a `tier` (`selected`/`active`/`inactive`/`shadow`) and deduping so each file is fetched once. **Pure, no VSCode** — unit-tested in `__tests__/tieredGraphBuilder.test.ts` with a fake project. Because each pass expands the *previous* ring, every non-shadow node's neighbourhood is preloaded, so selecting any visible node needs no fresh fetch; shadow nodes are the loaded boundary.
- **VSCode glue** (`src/commands/graphView.ts`) — `GraphSideView.runTieredBuild` wires `buildFocusedGraph` as the expander and webview `postMessage` as the sink. The webview owns all rendering/layout in an inline `<script>`. The wire `tier` label has three values (`active`/`inactive`/`shadow`) — the selected node is the `active`-tier node tracked separately via `activeId`.
- **Lazy-expand on hover** (`GraphSideView.hoverExpand`) — a shadow node's own callers/deps sit one hop *past* the loaded frontier, so the build never resolves them. Hovering a not-yet-expanded node (debounced) asks the host to `buildFocusedGraph` it (cache-served after the first time) and patches the full neighbourhood back via `hoverNeighbourhood`, so its status-bar count and revealed context match a click without re-centring. The status bar counts *live loaded edges*, so a node's count is only complete once it (or all its neighbours) have been expanded.
