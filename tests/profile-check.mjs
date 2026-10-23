/**
 * Compose the desktop profile directly (the CLI reserves that name for the
 * Electron carrier) and report the patch layers plus our own row.
 *
 *   node tests/profile-check.mjs
 */
const home = process.env.DSH_HOME ?? 'D:/DSH-Data'
process.env.DSH_HOME = home
process.argv = [process.execPath, 'profile-check']

const boot = await import('file:///D:/nodejs/node_global/node_modules/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js')

const prepareProfile = boot.prepareProfile ?? boot.a
const profile = prepareProfile('desktop', true)

console.log('profile dir:', profile.dir)
console.log('layers:', profile.layers.map((layer) => layer.packageName).join(' | '))
const patchText = JSON.stringify(profile, (key, value) => (typeof value === 'function' ? '[fn]' : value))
const rows = patchText.includes('dsh-git-branch-pill')
console.log('git-branch-pill referenced by the loaded profile:', rows)
process.exit(rows ? 0 : 1)
