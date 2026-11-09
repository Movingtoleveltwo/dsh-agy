import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/web/plugin.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
  },
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: false,
    // The standalone relay uses the official adapter base/error vocabulary,
    // but npm installs may omit every optional DSH peer. Bundle that library
    // and its transitive dependencies; never bootstrap a Cordis application.
    deps: { alwaysBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    // `react` and the DSH platform modules are shared into the frozen module
    // table by the shell (packages/client/web/src/platform.ts PLATFORM_MODULES):
    // the bundle must require them, never inline a second copy.
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    copy: [{ from: 'client.d.ts', rename: 'client.d.ts' }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-agy", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
