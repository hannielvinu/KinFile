import * as esbuild from 'esbuild';
const ctx = await esbuild.context({
  entryPoints: ['src/vscode/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
});
if (process.argv.includes('--watch')) await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }
