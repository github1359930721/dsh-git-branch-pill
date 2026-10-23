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
  useRef: (initial) => ({ current: initial }),
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

// Render with a stub hook seat. Every outcome must stay distinguishable:
// no session → nothing, unknown answer → warning pill, known non-repo → a
// muted "not git" pill rather than a vanished seat.
const render = (cwd) => {
  const useSessions = (selector) => selector({ byId: cwd === undefined ? {} : { 's-1': { cwd } } })
  return registered.component({ useSessions, sessionId: 's-1', t: undefined })
}

const unknown = render('D:\\project\\go\\IM-APP')
const noSession = render(undefined)

// Unknown: a warning pill, because silence cannot be told apart from "not a repo".
// The component returns `PillShell` (props.state = 'error') for that case.
const unknownIsWarning = unknown !== null && unknown !== undefined && unknown.props?.state === 'error'
if (!unknownIsWarning) failed += 1
console.log(`${unknownIsWarning ? 'PASS' : 'FAIL'} unknown answer renders a warning pill`)

// No session: nothing at all.
const noSessionOk = noSession === null || noSession === undefined
if (!noSessionOk) failed += 1
console.log(`${noSessionOk ? 'PASS' : 'FAIL'} hides without a session: ${JSON.stringify(noSession)}`)

// A known non-repository keeps a muted pill, so a plain folder Session never
// looks like the plugin failed to load.
globalThis.__seedAnswers?.('D:\\plain-folder', { repo: false, branch: null, detached: false })
const plain = render('D:\\plain-folder')
const plainOk = plain !== null && plain !== undefined && plain.props?.state === 'plain'
if (!plainOk) failed += 1
console.log(`${plainOk ? 'PASS' : 'FAIL'} confirmed non-repository renders a muted pill`)

// A repository with no resolvable branch (empty repo) also keeps a seat.
globalThis.__seedAnswers?.('D:\\empty-repo', { repo: true, branch: null, detached: false })
const noBranch = render('D:\\empty-repo')
const noBranchOk = noBranch !== null && noBranch !== undefined && noBranch.props?.state === 'plain'
if (!noBranchOk) failed += 1
console.log(`${noBranchOk ? 'PASS' : 'FAIL'} repository without a branch renders a muted pill`)

// A known branch renders the label button that offers the copy affordance.
globalThis.__seedAnswers?.('D:\\repo', { repo: true, branch: 'mzj', detached: false })
const repo = render('D:\\repo')
const button = repo?.children?.[0]
const repoOk = button?.type === 'button' && button?.props?.['data-git-branch'] === 'mzj' && button?.props?.onClick !== undefined
if (!repoOk) failed += 1
console.log(`${repoOk ? 'PASS' : 'FAIL'} known branch renders a clickable pill`)

// A vanished directory is reported rather than silently hidden.
globalThis.__seedAnswers?.('D:\\gone', { repo: false, branch: null, detached: false, reason: 'missing-directory' })
const gone = render('D:\\gone')
const goneOk = gone !== null && gone !== undefined && gone.props?.state === 'error'
if (!goneOk) failed += 1
console.log(`${goneOk ? 'PASS' : 'FAIL'} missing directory renders a warning pill`)

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
