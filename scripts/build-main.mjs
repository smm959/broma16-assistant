import { build, context } from 'esbuild'
import { rmSync } from 'node:fs'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const base = {
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist-electron',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  external: ['electron'],
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production') },
}

rmSync('dist-electron', { recursive: true, force: true })

if (watch) {
  const ctx = await context(base)
  await ctx.watch()
  console.log('[build-main] watching…')
} else {
  await build(base)
  console.log('[build-main] done')
}
