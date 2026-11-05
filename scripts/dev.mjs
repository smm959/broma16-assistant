import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { context } from 'esbuild'

const server = await createServer({ configFile: 'vite.config.ts' })
await server.listen()
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5178/'
console.log('[dev] renderer:', url)

const ctx = await context({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir: 'dist-electron',
  sourcemap: 'inline',
  external: ['electron'],
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  logLevel: 'info',
})
await ctx.watch()

const electron = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
})
electron.on('exit', async () => {
  await ctx.dispose()
  await server.close()
  process.exit(0)
})
