# End-to-end peek tests

These tests launch a **real VS Code** with the **Java language server** (`redhat.java`)
against the sample project in [`test-fixtures/gomatch-sample`](../../test-fixtures/gomatch-sample),
then drive the actual `Peek References (Filtered)` command and assert its structured
outcome. They exist to lock current behaviour per token and to give us a safe surface for
experimenting with the peek algorithm.

## How it fits together

- `test-fixtures/gomatch-sample/` — a small Spring Data JPA Maven project (package
  `com.gsuleimanov.sample`) with a repository, services, a controller and an entity. It
  reproduces the tokens we care about: a repository interface, an injected field, an
  inherited JPA method (`findById`), a project method, a method that returns a type, and
  a JDK type (`String`).
- `test/e2e/features/token-behavior.feature` — the Gherkin scenarios.
- `test/e2e/support/steps.ts` — step definitions. They open a file, place the cursor on a
  token, run `codenav.findReferences`, and assert on the returned
  [`PeekOutcome`](../../src/commands/peekOutcome.ts) (`status` + per-section file lists).
- `test/e2e/index.ts` — the `extensionTestsPath` entry; runs Cucumber inside the host.
- `test/e2e/runTest.ts` — downloads VS Code, installs `redhat.java`, and launches.

The command returns the outcome as its value, so steps assert it directly — no webview
scraping.

## Prerequisites

- A **JDK** (17+) on `PATH` / `JAVA_HOME` — `redhat.java` will not start without one.
- Network access on first run (downloads VS Code and the Java extension; Maven resolves
  `spring-boot-starter-*`).

## Run

```bash
npm run test:e2e
```

This builds the extension, compiles the harness to `out-e2e/`, then launches VS Code.
The first run is slow: VS Code download, extension install, and the JDT **project import**
(the `Given` step waits up to a few minutes for the language server to resolve symbols).

## Adding / changing scenarios

Edit `token-behavior.feature`. The reusable steps are:

- `When I peek references on "<token>" in "<file-relative-to-src-root>"`
- `Then the peek succeeds` / `Then the peek is refused`
- `Then the "<kind>" section includes "<path-fragment>"`
- `Then the "<kind>" section does not include "<path-fragment>"`

`<kind>` is a classification key: `typeDefinition`, `interface`, `definition`,
`implementation`, `reference`. Paths are matched by substring against the workspace-relative
path. To exercise the same-org-library inclusion, add a package prefix to
`codenav.includePackagePrefixes` in the sample project's `.vscode/settings.json`.

## Note on fidelity

These assert against the live JDT language server, so they reflect real LSP behaviour
(which is where most peek bugs have come from). The trade-off is that they are heavier and
slower than the pure unit tests in `src/commands/__tests__`, and depend on a local JDK.
