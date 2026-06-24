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

### 🕸️ Project graph view

Run **`Codenav: Open Project Graph`** from the command palette to open the **Codenav Project Graph** panel and visualize relationships across your project — types, fields, inheritance, and framework roles (Spring, Jakarta, Lombok and more).

## Usage

| Action | How |
| --- | --- |
| Filtered Find References | `Shift+Alt+F12` on a Java symbol |
| Open Project Graph | Command Palette → `Codenav: Open Project Graph` |

The References and Project Graph panels appear in the VSCode bottom panel area.
For better experience put it on Secondary panel.
I preffer `Shift+CMD+Enter` for a fluent experience: (`CMD+Enter` - go to definition with fallback to references), and adding `Shift` to that - you get better usage map.
Once Codenav References is focused, you can scroll through the references using arrows. Enter will jump the cursor to the file, Esc will return to the place from where you invoked Codenav References.

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
