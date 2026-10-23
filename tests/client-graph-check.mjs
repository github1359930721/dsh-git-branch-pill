/**
 * Compose the live desktop profile and report whether the client bundle is
 * part of the composed Client graph the page boots with.
 *
 *   node tests/client-graph-check.mjs
 */
process.env.DSH_HOME ??= 'E:\\DSH-Data'

const boot = await import('file:///D:/nodejs/node_global/node_modules/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js')
const prepareProfile = boot.prepareProfile ?? boot.a
const profile = prepareProfile('desktop', true)

const layers = profile.layers.map((layer) => layer.packageName)
console.log('bundles:', layers.length)
console.log('git-branch-pill layer:', layers.includes('dsh-git-branch-pill'))
console.log('skipped:', JSON.stringify(profile.skippedBundles ?? []))

const layer = profile.layers.find((entry) => entry.packageName === 'dsh-git-branch-pill')
console.log('layer:', JSON.stringify({ dir: layer?.packageDir, patches: layer?.patchPaths }))
