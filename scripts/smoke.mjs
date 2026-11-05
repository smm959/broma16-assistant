import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

await build({
  entryPoints: ['scripts/smoke.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist-electron/smoke.cjs',
  external: ['electron'],
  logLevel: 'error',
})
const res = spawnSync('npx', ['electron', 'dist-electron/smoke.cjs'], { stdio: 'inherit', env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_RUN_AS_NODE: '' } })
process.exit(res.status ?? 1)
