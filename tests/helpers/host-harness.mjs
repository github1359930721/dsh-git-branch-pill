/** VM-only host mocks: production code remains unchanged and helpers stay private. */
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'

export const directory = path.resolve(path.sep, 'host-fixture')
export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function mountHost(options = {}) {
  let now = 0, nextTimer = 0
  const timers = new Map()
  const setTimer = (fn, delay) => {
    const id = ++nextTimer
    timers.set(id, { at: now + delay, fn })
    return id
  }
  const clearTimer = (id) => timers.delete(id)
  // Drain VM async chains (stat, resolution, command, cache, subscriber, handler).
  const flush = async () => { for (let i = 0; i < 80; i += 1) await Promise.resolve() }
  const advance = async (ms) => {
    await flush()
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      now = due[1].at
      timers.delete(due[0])
      due[1].fn()
      await flush()
    }
    now = end
    await flush()
  }
  const calls = [], stats = [], resolutions = [], kills = [], active = new Set(), warnings = []
  const execFile = (executable, argv, config, callback) => {
    const call = { executable, argv, config, at: now }
    calls.push(call)
    const result = options.git?.(call, calls.length) ?? (
      argv[0] === 'symbolic-ref' ? { stdout: 'main\n' }
        : argv.includes('--is-inside-work-tree') ? { stdout: 'true\nfalse\n' }
          : { stdout: 'abcdef012345\n' }
    )
    if (result.throw) throw result.throw
    const child = new EventEmitter()
    let finished = false, timer
    const finish = (error, stdout = '', stderr = '') => {
      if (finished) return
      finished = true
      clearTimer(timer)
      active.delete(child)
      queueMicrotask(() => callback(error ?? null, stdout, stderr))
    }
    child.kill = (signal) => {
      kills.push({ call, signal, at: now })
      finish(Object.assign(new Error('killed'), { killed: true, signal }))
      return true
    }
    active.add(child)
    if ((result.delay ?? 0) >= config.timeout) {
      timer = setTimer(() => child.kill(config.killSignal), config.timeout)
    } else if (result.delay) {
      timer = setTimer(() => finish(result.error, result.stdout, result.stderr), result.delay)
    } else {
      queueMicrotask(() => finish(result.error, result.stdout, result.stderr))
    }
    return child
  }
  const stat = async (cwd) => {
    stats.push(cwd)
    return options.stat ? options.stat(cwd) : { isDirectory: () => true }
  }
  const subprocess = options.subprocess === false ? undefined : {
    resolveExecutable: async (name) => {
      resolutions.push({ name, at: now })
      return options.resolveExecutable ? options.resolveExecutable(name) : 'mock-git'
    },
  }
  const context = createContext({
    AbortController, URL, process: { platform: options.platform ?? process.platform, env: {} },
    setTimeout: setTimer, clearTimeout: clearTimer,
  })
  const module = new SourceTextModule(await readFile(new URL('../../index.js', import.meta.url), 'utf8'), {
    context, identifier: new URL('../../index.js', import.meta.url).href,
  })
  const modules = {
    'node:child_process': { execFile }, 'node:fs/promises': { stat },
    'node:path': { isAbsolute: path.isAbsolute, resolve: path.resolve },
    'node:perf_hooks': { performance: { now: () => now } },
  }
  await module.link((name) => {
    const exports = modules[name]
    if (!exports) throw new Error(`Unexpected import: ${name}`)
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  let route, dispose
  module.namespace.apply({
    get: (key) => key === 'connection' ? (options.connection === false ? undefined : options.connection ?? { requestRejection: () => undefined }) : key === 'subprocess' ? subprocess : undefined,
    logger: { warn: (...args) => warnings.push(args) },
    webServer: { register: (value) => { route = value; return () => {} } },
    effect: (fn) => { dispose = fn() },
  })
  const request = (cwd = directory, { fresh = false, method = 'GET', url } = {}) => {
    const req = new EventEmitter()
    Object.assign(req, { method, complete: true, url: url ?? `/api/dsh-git-branch?cwd=${encodeURIComponent(cwd)}${fresh ? '&fresh=1' : ''}` })
    const res = new EventEmitter()
    let result
    res.writeHead = (status, headers) => { result = { status, headers } }
    res.end = (body) => { res.writableEnded = true; result.body = JSON.parse(body) }
    const done = route.handler(req, res).then(() => result)
    return {
      req, res, done,
      abort: () => { req.aborted = true; req.emit('aborted') },
      close: () => { res.destroyed = true; res.emit('close') },
    }
  }
  const ask = async (...args) => { const pending = request(...args); await flush(); return pending.done }
  return {
    request, ask, flush, advance, calls, stats, resolutions, kills, active, warnings,
    dispose: () => dispose(), get timerCount() { return timers.size }, get now() { return now },
  }
}
