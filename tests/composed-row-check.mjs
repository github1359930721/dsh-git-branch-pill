/**
 * End-to-end check of the Client composition, without a browser:
 * compose the live desktop profile, build the Client module registry's row set
 * the way the page shell does, and assert our bundle becomes a servable row.
 *
 *   node tests/composed-row-check.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.DSH_HOME ??= 'E:\\DSH-Data'
const base = 'E:/dsh/resources/app/dsh/node_modules/@deepseek-ai'
const profileDir = join(process.env.DSH_HOME, 'profiles/desktop')

/** Mirror resolveMeta(): manifest -> Client row fields, or null. */
const resolveMeta = (packageName, packageDir) => {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const decl = pkg.dsh?.client
  if (decl === undefined || decl.platform !== 'web') return null
  const clientRel = pkg.exports?.['./client']
  if (clientRel === undefined) throw new Error(`${packageName}: dsh.client without ./client export`)
  return {
    id: packageName,
    clientPath: join(packageDir, clientRel),
    inject: decl.inject ?? [],
    immediately: decl.immediately === true,
  }
}

// The shell's seed table: what a factory may require without a graph edge.
const shell = readFileSync(join(base, 'dsh-web-frontend/dist/assets/index-CN7NIWNw.js'), 'utf8')
const seedBlock = shell.match(/function SZ\(\)\{return\{([\s\S]*?)\}\}/)
const seeds = seedBlock === null ? [] : [...seedBlock[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*)):/g)].map((match) => match[1] ?? match[2])

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
}

check('shell seed table parsed', seeds.length > 0, `${seeds.length} seeds`)
check('react is a seed module', seeds.includes('react'))

const row = resolveMeta('dsh-git-branch-pill', join(profileDir, 'node_modules/dsh-git-branch-pill'))
check('bundle resolves to a Client row', row !== null, row === null ? 'null' : JSON.stringify(row))

if (row !== null) {
  check('client bundle exists', /client\.js$/.test(row.clientPath), row.clientPath)
  const source = readFileSync(row.clientPath, 'utf8')
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  const unresolved = requires.filter((spec) => !seeds.includes(spec))
  check('every factory require is a seed module', unresolved.length === 0, unresolved.join(', ') || requires.join(', '))
  check('factory id matches the row id', source.includes(`id: 'dsh-git-branch-pill'`), 'id literal')
  check('inject list is non-empty', row.inject.length > 0, JSON.stringify(row.inject))
}

// The manifest must carry the bundle registration too, or the row never loads.
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
check('bundle selected in dsh.profile.bundles', (manifest.dsh?.profile?.bundles ?? []).includes('dsh-git-branch-pill'))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
