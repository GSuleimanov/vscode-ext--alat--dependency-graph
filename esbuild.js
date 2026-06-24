const esbuild = require('esbuild');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // web-tree-sitter is an emscripten module that loads its own .wasm at runtime;
  // keep it external and ship it (+ the grammar wasms) via .vscodeignore.
  external: ['vscode', 'web-tree-sitter'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: !production,
  minify: production,
};

if (watch) {
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch();
    console.log('Watching for changes...');
  });
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
