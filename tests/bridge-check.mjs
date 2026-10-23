/**
 * git-graph bridge: the pill may only offer switching when that plugin's routes
 * answer, and must degrade to copy-only when they do not.
 *
 *   node tests/bridge-check.mjs
 */
let registered = null

const React = {
  createElement: (type, props, ...children) => ({
    type: typeof type === 'function' ? (type.name || 'Anonymous') : type,
    props: props ?? {},
    children,
  }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
  memo: (component) => component,
}

const ctx = {
  get: (key) => (key === 'locale' ? { register: () => () => {} } : undefined),
  effect: (fn) => fn(),
  slots: { inject: (name, fn) => fn(), register: (options, component) => { registered = { options, component } } },
}
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply(ctx) } }
globalThis.document = { head: { append: () => {} }, createElement: () => ({ dataset: {}, remove: () => {} }) }

await import('../client.js')

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
}

// The component probes /git/config on mount; the render itself only needs the
// synchronous branch answer, so a seeded answer is enough to inspect the pill.
globalThis.__seedAnswers('D:\\repo', { repo: true, branch: 'mzj', detached: false })

const pill = registered.component({
  useSessions: (selector) => selector({ byId: { 's-1': { cwd: 'D:\\repo' } } }),
  sessionId: 's-1',
  t: undefined,
})
const button = pill?.children?.[0]

check('pill renders a button', button?.type === 'button')
check('branch is exposed for tests', button?.props?.['data-git-branch'] === 'mzj')
check('click handler is attached', typeof button?.props?.onClick === 'function')
// `canSwitch` starts false until the async probe resolves; a plain click must
// therefore copy rather than open a picker that cannot switch anything.
check('switchable defaults to false before the probe resolves', button?.props?.['data-switchable'] === 'false')
check('no menu is rendered by default', pill?.children?.[1] === null || pill?.children?.[1] === undefined)

// A click without the bridge must not throw (it copies or no-ops).
let threw = null
try {
  button?.props?.onClick?.({ ctrlKey: false, metaKey: false })
} catch (error) {
  threw = error
}
check('plain click is safe without the bridge', threw === null, threw === null ? 'ok' : String(threw))

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
