/**
 * Load the client bundle through a stub module loader and check what it
 * registers, with a hand-rolled React stand-in. The real React lives in the
 * browser page, so a render check here would only prove the stub.
 *
 *   node tests/client-check.mjs
 */
let registered = null
let injected = null
const effectCalls = []

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  memo: (component) => component,
}

const ctx = {
  get: (key) => (key === 'locale' ? { register: (ns, dict) => {
    effectCalls.push(`locale.register(${ns})`)
    if (!dict?.zh || !dict?.en) throw new Error('dictionary must carry zh and en')
    return () => {}
  } } : undefined),
  effect: (fn, label) => {
    effectCalls.push(`effect(${label ?? 'anonymous'})`)
    return fn()
  },
  slots: {
    inject: (name, fn) => {
      if (name !== 'conversation.composer.dock') throw new Error(`unexpected slot ${name}`)
      return fn()
    },
    register: (options, component) => {
      registered = { options, component }
      return () => {}
    },
  },
}

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      const plugin = factory((specifier) => {
        // Only seed modules of the page shell are reachable here.
        if (specifier !== 'react') throw new Error(`unexpected require(${specifier})`)
        return React
      })
      console.log('factory id:', id)
      injected = plugin.inject
      plugin.apply(ctx)
    },
  },
}
globalThis.document = {
  head: { append: () => {} },
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
}

await import('../client.js')

// The manifest must declare a Client half, or the registry never composes the
// bundle and no amount of correct component code reaches the page.
const manifest = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const decl = manifest.dsh?.client
const clientExport = manifest.exports?.['./client']

const options = registered?.options ?? {}
const checks = [
  ['manifest declares dsh.client', decl !== undefined, decl === undefined ? 'MISSING' : JSON.stringify(decl)],
  ['dsh.client.platform is web', decl?.platform === 'web', decl?.platform],
  ['manifest exports ./client', typeof clientExport === 'string', clientExport],
  ['plugin injects locale', Array.isArray(injected) && injected.includes('locale'), JSON.stringify(injected)],
  ['slot name', options.name === 'conversation.composer.dock', options.name],
  ['entry id', options.id === 'git-branch', options.id],
  ['order before shipped pills', typeof options.order === 'number' && options.order < 0, options.order],
  ['locale namespace', options.locale === 'gitBranchPill', options.locale],
  ['component registered', typeof registered?.component === 'function', typeof registered?.component],
  ['locale dictionary registered', effectCalls.includes('locale.register(gitBranchPill)'), effectCalls.join(', ')],
  ['stylesheet effect runs', effectCalls.some((entry) => entry.includes('styles')), effectCalls.join(', ')],
]

let failed = 0
for (const [name, ok, actual] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${String(actual)}`)
}

// Render the component with a stub hook seat: unknown answer hides, repo answer shows the branch.
const render = (cwd, answer) => {
  const component = registered.component
  const cache = {}
  const useSessions = (selector) => selector({ byId: cwd === undefined ? {} : { 's-1': { cwd } } })
  // The module caches answers privately; drive the visible path by rendering
  // after a no-op effect, so only the "no answer yet" branch is reachable here.
  void cache
  void answer
  return component({ useSessions, sessionId: 's-1', t: undefined })
}

const hidden = render('D:\\project\\go\\IM-APP')
const noSession = render(undefined)
const hiddenOk = hidden === null || hidden === undefined
const noSessionOk = noSession === null || noSession === undefined
if (!hiddenOk) failed += 1
if (!noSessionOk) failed += 1
console.log(`${hiddenOk ? 'PASS' : 'FAIL'} hides until the branch answer arrives: ${JSON.stringify(hidden)}`)
console.log(`${noSessionOk ? 'PASS' : 'FAIL'} hides without a session: ${JSON.stringify(noSession)}`)

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
