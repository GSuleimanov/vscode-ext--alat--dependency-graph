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
node --require ts-node/register --test src/commands/__tests__/expandViaType.test.ts
```

## Architecture

This is a VSCode extension (`src/extension.ts` is the entry point) that enhances Java reference navigation. The extension is bundled with esbuild — `vscode` is external and injected at runtime.

### Core data flow

1. **Command trigger** (`src/commands/filteredPeek.ts`) — `Shift+Alt+F12` on a Java symbol fires `codenav.findReferences`. It calls four VSCode LSP providers in parallel (references, type definitions, definitions, implementations), then runs `expandViaTypeDefinitions` to widen the result set.

2. **Type expansion** (`src/commands/expandViaType.ts`) — Pure logic (no VSCode imports) with an injected `TypeExpansionExecutor`. Given a symbol's type definition location, it:
   - Fetches cross-file locations that reference the type (field declarations in other classes)
   - Classifies each: if `executeDefinitionProvider` at that location points back to the type → it's a field declaration → added to `defLocations`
   - Runs `executeReferenceProvider` at the **variable name column** (not the type name column) of each field declaration to get method-call usages
   - Deduplicates by `uri:line` throughout
   
   This ensures calling on an instance variable (`profileRepository`) shows the same cross-file usages as calling on the type name (`ProfileRepository`).

3. **Side panel** (`src/views/referencesSideView.ts`) — `WebviewViewProvider` that renders results in the VSCode panel. Receives a `PanelInput` and rebuilds HTML via `postMessage`. On `buildData`, raw locations are deduped by `uri:line` (LSP can return multiple locations per line for multiple symbol occurrences), then classified and grouped as: Type Definitions → Definitions → Implementations → References → Tests.

4. **Classification** (`src/util/locationClassifier.ts`) — Pure function, key-based: a location is a "definition" only if its `fsPath:line` is in the `defLocs` set passed in. No heuristics.

5. **Filtering** (`src/util/javaUtils.ts`) — Strips import statements and test-source locations from the reference list before display.

### Key design constraints

- `expandViaType.ts` uses a `Loc` interface (minimal subset of `vscode.Location`) so it can be unit-tested without VSCode. Cast to/from `vscode.Location[]` happens only in `filteredPeek.ts`.
- The webview has strict CSP (`default-src 'none'`) with nonce-gated scripts and styles.
- All keyboard navigation and preview logic lives in the inline `<script>` of `buildHtml()` in `referencesSideView.ts`. Preview fires only on keyboard arrow selection (not hover). Hover only highlights via CSS `:hover`.
