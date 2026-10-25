import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Run the shipped components' effects with a deterministic clock and fetch.
export function clientHarness(fetch, options = {}) {
  let now = 0
  let component
  let tree
  let menuTree
  let menuSeat
  let directory = '/workspace/repo'
  let current
  let cursor = 0
  let mounted = true
  let nextTimer = 0
  const timers = new Map()
  const listeners = new Map()
  const pendingEffects = []
  const focused = []
  const seat = () => ({ hooks: [], dirty: true, mounted: true })
  const rootSeat = seat()
  const events = target => ({
    addEventListener(name, fn) {
      const key = `${target}:${name}`
      if (!listeners.has(key)) listeners.set(key, new Set())
      listeners.get(key).add(fn)
    },
    removeEventListener(name, fn) { listeners.get(`${target}:${name}`)?.delete(fn) },
  })
  const schedule = (fn, delay, repeat) => {
    const id = ++nextTimer
    timers.set(id, { fn, delay, repeat, at: now + delay })
    return id
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const owner = current
      const index = cursor++
      owner.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [owner.hooks[index].value, next => {
        const value = typeof next === 'function' ? next(owner.hooks[index].value) : next
        if (owner.mounted && !Object.is(value, owner.hooks[index].value)) {
          owner.hooks[index].value = value
          owner.dirty = true
        }
      }]
    },
    useRef(initial) {
      const index = cursor++
      current.hooks[index] ??= { current: initial }
      return current.hooks[index]
    },
    useEffect(effect, deps) {
      const owner = current
      const index = cursor++
      const previous = owner.hooks[index]
      if (previous && deps && previous.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
      owner.hooks[index] = { deps, cleanup: previous?.cleanup }
      pendingEffects.push(() => {
        if (!owner.mounted) return
        owner.hooks[index].cleanup?.()
        owner.hooks[index].cleanup = effect()
      })
    },
  }
  const document = {
    ...events('document'),
    hidden: options.hidden ?? false,
    head: { append() {} },
    createElement: () => ({ dataset: {}, remove() {} }),
  }
  const ctx = {
    get: () => undefined,
    effect: fn => fn(),
    slots: {
      inject: (name, fn) => fn(),
      register: (registration, value) => { component = value },
    },
  }
  const sandbox = {
    console: { error() {} },
    document,
    Date: class extends Date { static now() { return now } },
    AbortSignal,
    AbortController,
    fetch: (url, init) => options.statusFetch && String(url).startsWith('/api/dsh-git-status') ? options.statusFetch(url, init) : String(url).startsWith('/api/dsh-git-status') ? Promise.resolve(response({ repo: true, dirty: false, modifiedFiles: 0, untrackedFiles: 0, conflicts: 0 })) : fetch(url, init),
    navigator: { clipboard: options.clipboard, platform: 'Win32' },
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: id => timers.delete(id),
    setTimeout: (fn, delay) => schedule(fn, delay, false),
    clearTimeout: id => timers.delete(id),
    window: { ...events('window'), __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply(ctx) } },
  }
  vm.runInNewContext(readFileSync(new URL('../../client.js', import.meta.url), 'utf8'), sandbox)

  const attachRefs = node => {
    if (!node || typeof node !== 'object') return
    if (node.props?.ref && node.props.ref.current === null) {
      node.props.ref.current = {
        focus() { focused.push(node.type) },
        scrollIntoView() {},
        contains(target) { return target === this },
        getBoundingClientRect: () => ({ left: 24, top: 120 }),
      }
    }
    if (typeof node.props?.ref === 'function') {
      const element = { focus() { focused.push(node.props.title ?? node.type) }, scrollIntoView() {} }
      node.props.ref(element)
    }
    for (const child of node.children ?? []) {
      if (Array.isArray(child)) child.forEach(attachRefs)
      else attachRefs(child)
    }
  }
  const dispose = owner => {
    if (!owner) return
    owner.mounted = false
    for (const hook of owner.hooks) hook.cleanup?.()
  }
  const render = (owner, fn, props) => {
    current = owner
    cursor = 0
    owner.dirty = false
    const value = fn(props)
    attachRefs(value)
    return value
  }
  const flush = async () => {
    for (let step = 0; step < 60; step++) {
      let parentRendered = false
      if (mounted && rootSeat.dirty) {
        tree = render(rootSeat, component, {
          useSessions: selector => selector({ byId: { session: { cwd: directory } } }),
          sessionId: 'session',
        })
        parentRendered = true
      }
      const menu = tree?.children?.[1]
      if (mounted && typeof menu?.type === 'function') {
        if (!menuSeat || menuSeat.key !== menu.props.key) {
          dispose(menuSeat)
          menuSeat = { ...seat(), key: menu.props.key }
        }
        if (parentRendered || menuSeat.dirty) menuTree = render(menuSeat, menu.type, menu.props)
      } else if (menuSeat) {
        dispose(menuSeat)
        menuSeat = undefined
        menuTree = undefined
      }
      while (pendingEffects.length) pendingEffects.shift()()
      await Promise.resolve()
    }
  }
  const emit = async (target, name, event = {}) => {
    for (const listener of listeners.get(`${target}:${name}`) ?? []) listener(event)
    await flush()
  }
  return {
    flush,
    get tree() { return tree },
    get menu() { return menuTree },
    get menuProps() { return tree?.children?.[1]?.props },
    get button() { return tree?.children?.[0] },
    get focused() { return focused },
    get timerCount() { return timers.size },
    get listenerCount() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0) },
    async advance(ms) {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at
        if (timer.repeat) timer.at += timer.delay
        else timers.delete(id)
        timer.fn()
        await flush()
      }
      now = end
      await flush()
    },
    async visibility(hidden) { document.hidden = hidden; await emit('document', 'visibilitychange') },
    online: () => emit('window', 'online'),
    key: key => emit('document', 'keydown', { key, stopPropagation() {} }),
    outside: () => emit('document', 'pointerdown', { target: {} }),
    async openMenu() { tree.children[0].props.onClick({ ctrlKey: false, metaKey: false }); await flush() },
    async copy() { tree.children[0].props.onClick({ ctrlKey: true, metaKey: false }); await flush() },
    async changeDirectory(value) { directory = value; rootSeat.dirty = true; await flush() },
    unmount() { mounted = false; dispose(menuSeat); dispose(rootSeat) },
  }
}

export const response = body => ({ ok: true, json: async () => body })
export function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    for (const entry of Array.isArray(child) ? child : [child]) {
      const match = findNode(entry, predicate)
      if (match) return match
    }
  }
}
