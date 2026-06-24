import { Given, When, Then } from '@cucumber/cucumber';

// ── Background ────────────────────────────────────────────────────────────────

Given('the Codenav extension is active', function () {
  return 'pending';
});

Given('a Java project is open with both src/main and src/test source roots', function () {
  return 'pending';
});

// ── Scenario: test source root filtering ──────────────────────────────────────

Given('I have a class {string} referenced in both src/main/java and src/test/java', function (_className: string) {
  return 'pending';
});

When('I invoke {string} on {string}', function (_command: string, _target: string) {
  return 'pending';
});

Then('the peek window shows only references from src/main/**', function () {
  return 'pending';
});

Then('references whose path contains {string} are not shown', function (_pathSegment: string) {
  return 'pending';
});

// ── Scenario: naming convention fallback ──────────────────────────────────────

Given('I have a project where test files live outside src/test/ but are named {string}', function (_filename: string) {
  return 'pending';
});

Then('references in files matching {string}, {string}, or {string} are excluded', function (_p1: string, _p2: string, _p3: string) {
  return 'pending';
});

// ── Scenario: import filtering ────────────────────────────────────────────────

Given('I have a class {string} imported in {int} files and used in {int} files', function (_className: string, _importCount: number, _useCount: number) {
  return 'pending';
});

Then('the peek window shows only the {int} non-import usages', function (_count: number) {
  return 'pending';
});

Then('import statements are not included in the results', function () {
  return 'pending';
});

// ── Scenario: toggle filters ──────────────────────────────────────────────────

Given('I have invoked {string} on {string}', function (_command: string, _target: string) {
  return 'pending';
});

When('I toggle {string} in the filter panel', function (_filterName: string) {
  return 'pending';
});

Then('references whose path contains {string} appear in the peek window', function (_pathSegment: string) {
  return 'pending';
});

Then('the filter state is persisted for the session', function () {
  return 'pending';
});

// ── Scenario: configurable test source roots ──────────────────────────────────

Given('my project uses {string} for integration tests instead of {string}', function (_actual: string, _default: string) {
  return 'pending';
});

Given('I have added {string} to the {string} setting', function (_value: string, _setting: string) {
  return 'pending';
});

When('I invoke {string} on any symbol', function (_command: string) {
  return 'pending';
});

Then('references under {string} are also excluded', function (_pathSegment: string) {
  return 'pending';
});

// ── Scenario: filter status visible ──────────────────────────────────────────

Then('a status indicator shows which filters are active', function () {
  return 'pending';
});

Then('the result count reflects the filtered set', function () {
  return 'pending';
});

// ── Scenario: LSP unavailable fallback ───────────────────────────────────────

Given('the Java Language Server is not running', function () {
  return 'pending';
});

When('I invoke {string}', function (_command: string) {
  return 'pending';
});

Then('a notification informs me that Java LSP is required', function () {
  return 'pending';
});

Then('no empty peek window is opened', function () {
  return 'pending';
});

// ── Scenario: keyboard shortcut ───────────────────────────────────────────────

Given('the cursor is on a Java symbol', function () {
  return 'pending';
});

When('I press the configured shortcut for {string}', function (_actionName: string) {
  return 'pending';
});

Then('the filtered peek window opens immediately', function () {
  return 'pending';
});

Then('the default filters (no tests, no imports) are applied', function () {
  return 'pending';
});
