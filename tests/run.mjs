import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const commands = [
  ['--check', 'index.js'],
  ['--check', 'client.js'],
  ['--experimental-vm-modules', '--test', 'tests/client-behavior.mjs', 'tests/host-behavior.mjs'],
  ['tests/client-check.mjs'],
  ['tests/bridge-check.mjs'],
  ['tests/handler-check.mjs'],
  ['tests/host-hardening.mjs'],
  ['tests/poll-behavior.mjs'],
]
for (const args of commands) {
  console.log(`\n> node ${args.join(' ')}`)
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 120000 })
  if (result.error) console.error(result.error)
  if (result.error || result.status !== 0) {
    process.exitCode = result.status || 1
    break
  }
}
