/**
 * Host half of the Git branch pill: a short-lived, directory-deduplicated cache
 * behind the Host's connection trust fence.
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

export const inject = ['webServer', 'connection']

const ENDPOINT = '/api/dsh-git-branch'
const CACHE_TTL_MS = 2_000
const FAILURE_TTL_MS = 8_000
/** Whole lookup budget, including stat, executable resolution and all commands. */
const GIT_TIMEOUT_MS = 4_000
const CACHE_LIMIT = 256

const failure = (reason) => Object.assign(new Error(reason), { reason })
const answerFor = (reason) => ({
  repo: false, branch: null, detached: false, reason,
  ...(reason === 'git-missing' ? { gitMissing: true } : {}),
})

/** Stop waiting on an unabortable host resolver/stat without running later work. */
const waitFor = (promise, signal) => new Promise((fulfill, reject) => {
  if (signal.aborted) return reject(signal.reason)
  const aborted = () => { cleanup(); reject(signal.reason) }
  const cleanup = () => signal.removeEventListener('abort', aborted)
  signal.addEventListener('abort', aborted, { once: true })
  Promise.resolve(promise).then(
    (value) => { cleanup(); fulfill(value) },
    (error) => { cleanup(); reject(error) },
  )
})

/** Only positively identified Git diagnostics are normal non-repository results. */
const gitFailure = (error, stderr = '') => {
  if (error?.code === 'ENOENT' || error?.name === 'SubprocessExecutableNotFoundError' || /\bENOENT\b/.test(error?.message ?? '')) return 'git-missing'
  if (error?.code === 'EACCES' || error?.code === 'EPERM'
    || /^fatal: detected dubious ownership in repository at /m.test(stderr)
    || /^fatal: .*Permission denied/m.test(stderr)) return 'git-permission-denied'
  if (error?.killed && error?.signal === 'SIGKILL') return 'git-timeout'
  return 'git-failed'
}

export function apply(ctx) {
  const cache = new Map()
  const inFlight = new Map()
  // Success can be reused until spawn reports ENOENT. Failures expire, allowing
  // PATH/installation/permission repairs to recover without restarting the Host.
  let gitResolution

  const cached = (key) => {
    const entry = cache.get(key)
    if (entry === undefined) return undefined
    if (performance.now() - entry.at >= entry.ttl) {
      cache.delete(key)
      return undefined
    }
    cache.delete(key)
    cache.set(key, entry)
    return entry.value
  }

  const remember = (key, value) => {
    cache.delete(key)
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
    cache.set(key, {
      value, at: performance.now(), ttl: value.repo ? CACHE_TTL_MS : FAILURE_TTL_MS,
    })
  }

  const resolveGit = async (signal) => {
    signal.throwIfAborted()
    if (gitResolution && performance.now() - gitResolution.at < gitResolution.ttl) {
      if (gitResolution.reason) throw failure(gitResolution.reason)
      return gitResolution.executable
    }
    try {
      const subprocess = ctx.get('subprocess')
      const executable = typeof subprocess?.resolveExecutable === 'function'
        ? await waitFor(Promise.resolve().then(() => {
          signal.throwIfAborted()
          return subprocess.resolveExecutable('git', undefined, signal)
        }), signal)
        : 'git'
      signal.throwIfAborted()
      if (typeof executable !== 'string' || executable.trim() === '') throw failure('git-missing')
      gitResolution = { executable, at: performance.now(), ttl: Infinity }
      return executable
    } catch (error) {
      signal.throwIfAborted()
      const reason = error?.reason ?? gitFailure(error)
      gitResolution = { reason, at: performance.now(), ttl: FAILURE_TTL_MS }
      ctx.logger.warn('git-branch-pill: executable resolution failed: %s', error)
      throw failure(reason)
    }
  }

  /** Keep the exit status and stderr; a failed command is not a null branch. */
  const git = (cwd, executable, argv, task) => new Promise((fulfill, reject) => {
    const { signal } = task.controller
    const remaining = Math.ceil(task.deadline - performance.now())
    if (signal.aborted) return reject(signal.reason)
    if (remaining <= 0) return reject(failure('git-timeout'))
    let child
    const aborted = () => {
      child?.kill('SIGKILL')
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      child = execFile(executable, argv, {
        cwd, timeout: remaining, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024,
        // Stable diagnostics make nonrepo/safe.directory classification reliable.
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout, stderr) => {
        cleanup()
        if (signal.aborted) return reject(signal.reason)
        fulfill({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    } catch (error) {
      cleanup()
      reject(failure(gitFailure(error)))
    }
  })

  const requireSuccess = (result) => {
    if (!result.error) return result.stdout.trim()
    const reason = gitFailure(result.error, result.stderr)
    if (reason === 'git-missing') {
      gitResolution = { reason, at: performance.now(), ttl: FAILURE_TTL_MS }
    }
    throw failure(reason)
  }

  const readBranch = async (cwd, task) => {
    const executable = await resolveGit(task.controller.signal)
    // Both flags in one invocation: bare/.git directories need no HEAD query.
    const flags = await git(cwd, executable,
      ['rev-parse', '--is-inside-work-tree', '--is-bare-repository'], task)
    if (flags.error?.code === 128
      && /^fatal: not a git repository(?:[ (:])/m.test(flags.stderr)) {
      return { repo: false, branch: null, detached: false }
    }
    const [inside, bare] = requireSuccess(flags).split(/\r?\n/)
    if (!['true', 'false'].includes(inside) || !['true', 'false'].includes(bare)) {
      throw failure('git-failed')
    }
    if (inside !== 'true') return { repo: bare === 'true', branch: null, detached: false }

    const head = await git(cwd, executable, ['symbolic-ref', '--quiet', '--short', 'HEAD'], task)
    if (!head.error) {
      const branch = requireSuccess(head)
      if (!branch) throw failure('git-failed')
      // symbolic-ref works for unborn (empty) repositories too.
      return { repo: true, branch, detached: false }
    }
    // Exit 1, with no diagnostic, is symbolic-ref's documented detached case.
    if (head.error.code !== 1 || head.stderr.trim() !== '') requireSuccess(head)
    const sha = requireSuccess(await git(cwd, executable, ['rev-parse', '--short', 'HEAD'], task))
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw failure('git-failed')
    return { repo: true, branch: sha.slice(0, 7), detached: true }
  }

  const queryDirectory = async (directory, task) => {
    let info
    try {
      info = await waitFor(stat(directory), task.controller.signal)
    } catch (error) {
      task.controller.signal.throwIfAborted()
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return answerFor('missing-directory')
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return answerFor('directory-permission-denied')
      return answerFor('directory-unavailable')
    }
    task.controller.signal.throwIfAborted()
    if (!info.isDirectory()) return answerFor('missing-directory')
    return readBranch(directory, task)
  }

  const startLookup = (key, directory, fresh) => {
    const task = {
      controller: new AbortController(), deadline: performance.now() + GIT_TIMEOUT_MS,
      users: 0, settled: false, fresh,
    }
    const timer = setTimeout(() => task.controller.abort(failure('git-timeout')), GIT_TIMEOUT_MS)
    inFlight.set(key, task)
    task.promise = queryDirectory(directory, task).catch((error) => {
      if (task.controller.signal.aborted) throw task.controller.signal.reason
      return answerFor(error?.reason ?? 'git-failed')
    }).then((answer) => {
      task.controller.signal.throwIfAborted()
      remember(key, answer)
      return answer
    }).finally(() => {
      task.settled = true
      clearTimeout(timer)
      if (inFlight.get(key) === task) inFlight.delete(key)
    })
    // Cancellation may leave no consumers; still observe the task's rejection.
    task.promise.catch(() => {})
    return task
  }

  const subscribe = async (key, task, signal) => {
    signal.throwIfAborted()
    task.users += 1
    try {
      return await waitFor(task.promise, signal)
    } finally {
      task.users -= 1
      // A disconnected shared caller must not kill another caller's Git query.
      if (task.users === 0 && !task.settled) {
        task.controller.abort(failure('cancelled'))
        if (inFlight.get(key) === task) inFlight.delete(key)
      }
    }
  }

  const lookup = async (directory, fresh, signal) => {
    signal.throwIfAborted()
    if (!isAbsolute(directory)) return answerFor('invalid-directory')
    const normalized = resolve(directory)
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    for (;;) {
      signal.throwIfAborted()
      const running = inFlight.get(key)
      if (running) {
        if (!fresh || running.fresh) return subscribe(key, running, signal)
        // Fresh never reuses an older ordinary poll. Concurrent fresh requests
        // share the next query, and all waiting time uses the caller's budget.
        await subscribe(key, running, signal)
        continue
      }
      if (!fresh) {
        const hit = cached(key)
        if (hit !== undefined) return hit
      }
      return subscribe(key, startLookup(key, normalized, fresh), signal)
    }
  }

  const handler = async (request, response) => {
    let disconnected = request.aborted || response.destroyed
    const send = (status, body) => {
      if (disconnected || response.destroyed || response.writableEnded) return
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      })
      response.end(JSON.stringify(body))
    }
    if (disconnected) return
    if (request.method !== 'GET') return send(405, { error: 'method-not-allowed' })

    // WebServer dispatches custom routes without applying the connection fence.
    try {
      const connection = ctx.get('connection')
      if (typeof connection?.requestRejection !== 'function') return send(503, { error: 'auth-unavailable' })
      const rejection = connection.requestRejection(request)
      if (rejection !== undefined) return send(rejection, { error: 'unauthorized' })
    } catch (error) {
      ctx.logger.warn('git-branch-pill: requestRejection failed: %s', error)
      return send(503, { error: 'auth-unavailable' })
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    const directory = url.searchParams.get('cwd') ?? url.searchParams.get('directory') ?? ''
    if (directory === '') return send(400, { error: 'missing-directory' })
    const controller = new AbortController()
    const disconnect = () => {
      disconnected = true
      controller.abort(failure('cancelled'))
    }
    // IncomingMessage.close can be normal GET completion, not a disconnect.
    const requestClosed = () => { if (request.complete === false) disconnect() }
    const responseClosed = () => { if (!response.writableEnded) disconnect() }
    request.on?.('aborted', disconnect)
    request.on?.('close', requestClosed)
    response.on?.('close', responseClosed)
    const timer = setTimeout(() => controller.abort(failure('git-timeout')), GIT_TIMEOUT_MS)
    try {
      return send(200, await lookup(directory, url.searchParams.get('fresh') === '1', controller.signal))
    } catch (error) {
      if (disconnected) return
      if (error?.reason === 'git-timeout') return send(200, answerFor('git-timeout'))
      ctx.logger.warn('git-branch-pill: lookup failed: %s', error)
      return send(500, { error: 'lookup-failed' })
    } finally {
      clearTimeout(timer)
      request.removeListener?.('aborted', disconnect)
      request.removeListener?.('close', requestClosed)
      response.removeListener?.('close', responseClosed)
    }
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'exact', path: ENDPOINT, handler })
    return () => {
      unregister()
      for (const task of inFlight.values()) task.controller.abort(failure('cancelled'))
      inFlight.clear()
      cache.clear()
    }
  })
}
