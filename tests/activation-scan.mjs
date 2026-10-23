/**
 * Report why the plugin's Client half is or is not part of the page graph:
 * compare our manifest declaration with a shipped plugin that does render.
 *
 *   node tests/activation-scan.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? 'E:\\DSH-Data'
const base = 'E:/dsh/resources/app/dsh/node_modules/@deepseek-ai'

/** Mirror of dsh-client-modules `resolveMeta`: manifest -> graph row or null. */
const inspect = (label, packageDir) => {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return { label, state: 'missing-manifest', manifestPath }
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const decl = pkg.dsh?.client
  if (decl === undefined) return { label, name: pkg.name, state: 'no dsh.client' }
  if (decl.platform !== 'web') return { label, name: pkg.name, state: `platform=${decl.platform}` }
  const clientExport = pkg.exports?.['./client']
  if (clientExport === undefined) return { label, name: pkg.name, state: 'dsh.client without ./client export' }
  return { label, name: pkg.name, state: 'CLIENT ROW', client: clientExport, inject: decl.inject ?? [] }
}

const rows = [
  inspect('our plugin', join(home, 'profiles/desktop/node_modules/dsh-git-branch-pill')),
  inspect('shipped goal', join(base, 'dsh-client-ui-goal')),
]

for (const row of rows) console.log(JSON.stringify(row, null, 2))

// Which seed modules may a factory require? These come from the shell bundle.
const shell = join(base, 'dsh-web-frontend/dist/assets/index-CN7NIWNw.js')
const shellText = readFileSync(shell, 'utf8')
const seedBlock = shellText.match(/react\/jsx-runtime":\w+[\s\S]{0,600}?\}\}/)
const names = seedBlock === null ? [] : [...seedBlock[0].matchAll(/"(@?[\w./-]+)":\w+/g)].map((match) => match[1])
console.log('\nseed modules:', names.join(', '))
console.log('locale is a seed module:', names.includes('@deepseek-ai/dsh-client-locale'))
