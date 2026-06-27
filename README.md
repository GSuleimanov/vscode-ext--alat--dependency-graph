# Codenav

Enhanced navigation and visualization for Java projects in VSCode. Especially with a Spring Projects.

Codenav builds on top of the Java language server to give you **cleaner, smarter reference navigation** and a **project relationship graph** — cutting through the noise of import statements, tests, definitions and etc.

## Features

### 🔍 Filtered reference navigation

Press **`Shift+Alt+F12`** on any Java symbol to open the **Codenav References** panel. Unlike the built-in "Find All References", Codenav:

- **Expands via type definitions** — you get consistent experience when browsing the codebase.
- **Groups results** into Type Definitions → Definitions → Implementations → References → Tests.
- **Filters out the noise** — import statements and test-source results are hidden by default (configurable).
- **Keyboard-first preview** — arrow through results to preview each location inline.

### 🕸️ Explorable class graph

Run **`Codenav: Open Project Graph`** from the command palette — or click the graph icon in the **Codenav References** title bar — to open the graph as an editor tab. It centres on whichever class is active and shows its immediate neighbourhood:

```
  [ CallerA ]   [ CallerB ]      ← classes that use this class
         ↘         ↙
        [ ActiveClass ]          ← the selected class, centred
         ↙         ↘
  [ FieldDepA ]  [ FieldDepB ]   ← classes this one uses
```

- **Focused by default** — selecting a class shows just it plus one hop (callers above, dependencies below), with the next hop out drawn faded for context. Pick another class and the view smoothly re-centres, keeping shared nodes in place.
- **Single-click** a node to focus it — the camera glides over and the file opens in a **preview** tab, so you can keep clicking around without losing your place.
- **Double-click** to open the file for real (pinned tab, focus moves to the editor).
- **Hover** any node to switch context to it — its connections light up as active while everything else dims.
- **Persist** (toggle, bottom-right) keeps every visited class on one growing map instead of replacing the view each time.

It renders in stages for instant feedback — the active class and its field dependencies appear in milliseconds (tree-sitter), callers and siblings fill in as the language server responds.

The graph is positioned with a **Sugiyama-style layered layout** — cycles are broken into a DAG, each class is ranked into a row by **longest-path layer assignment** (so layout depth reflects true dependency depth), edge crossings are minimized with the median heuristic, and a tier-aware coordinate pass keeps the selected class and its neighbours centred. See [docs/graph.md](docs/graph.md) for the algorithm and references.


#### How the hybrid engine works

The graph uses two data sources chosen for what each does best:

| Data | Source | Why |
|---|---|---|
| Active class + field types | **tree-sitter** (static parse) | Single-file parse takes ~5 ms; no LSP round-trip needed |
| Callers (who uses this class) | **LSP** `executeReferenceProvider` | Project-wide index already maintained by the language server; correct across all files without scanning anything |
| Siblings (other subclasses of the parent) | **LSP** `executeImplementationProvider` | Same reason — language server knows the full type hierarchy |

This means the graph never scans the whole workspace on load. It reads exactly one file synchronously (tree-sitter), then asks the already-running language server for the rest. On a large project the difference is seconds vs milliseconds for the initial render.

## Usage

| Action | How |
| --- | --- |
| Filtered Find References | `Shift+Alt+F12` on a Java symbol |
| Open Project Graph | Command Palette → `Codenav: Open Project Graph`, or the graph icon in the References title bar |
| Explore the graph | Single-click to focus + preview · double-click to open the file · hover to switch context to a node · **Persist** to keep the whole map |

The References panel lives in the VSCode bottom panel area (for a better experience move it to the Secondary panel); the Project Graph opens as an editor tab, so it sits beside your code.

Tip: bind `Shift+Cmd+Enter` for a fluent flow — `Cmd+Enter` goes to definition (falling back to references), and adding `Shift` opens the usage map. Once the References panel is focused, arrow through results, **Enter** jumps the cursor to the file, and **Esc** returns to where you invoked it.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `codenav.testSourceRoots` | `["src/test/", "src/it/", "src/integration-test/"]` | Path segments identifying test source roots, excluded from filtered peek. |
| `codenav.testFilePatterns` | `["Test.java", "Tests.java", "TestCase.java", "Spec.java"]` | Filename suffixes (fallback) identifying test files. |
| `codenav.filterImports` | `true` | Exclude import-statement references. |
| `codenav.includeTests` | `false` | Include references from test sources. |
| `codenav.hideDefinitions` | `false` | Hide the Definitions section. |
| `codenav.currentClassOnly` | `false` | Limit filtered peek to the current class (faster); toggle off in the panel to load whole-project references on demand. |
| `codenav.includePackagePrefixes` | `[]` | Package prefixes whose library results to include (e.g. `com.example`). Anything not in the project and not matching a prefix is neither shown nor searched. |

## Requirements

- VSCode `^1.64.0`
- A Java language server (e.g. the [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java) extension) for reference/definition providers.

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
