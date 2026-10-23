/**
 * Host half of the Git branch pill.
 *
 * The browser half needs one fact per workspace directory: which Git branch is
 * checked out there. It is served from a small authenticated JSON endpoint and
 * cached for a couple of seconds, because the page polls each visible Session
 * and `git` startup is the only real cost in this plugin.
 *
 * Cost note: a poll that hits the cache spawns nothing. Only a cached answer
 * older than {@link CACHE_TTL_MS} (or an explicit `?fresh=1`) runs `git`, so N
 * open Sessions in one directory still cost at most one spawn per TTL window.
 *
 * @module dsh-git-branch-pill
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const inject = ['webServer']

/** One HTTP path; the browser half hard-codes the same string. */
const ENDPOINT = '/api/dsh-git-branch'

/**
 * Short enough that a `git checkout` shows up within one poll tick, long enough
 * that a polling page shares one `git` spawn per directory per window.
 */
const CACHE_TTL_MS = 2_000
/** A failed lookup is retried sooner than a good one is refreshed. */
const FAILURE_TTL_MS = 8_000
/** `git` is a one-shot child process; never let a stalled one hold the request. */
const GIT_TIMEOUT_MS = 4_000

/** Bounded cache: a long Session lifetime can cycle through many directories. */
const CACHE_LIMIT = 256

export function apply(ctx) {
  /** @type {Map<string, { value: unknown, at: number, ttl: number }>} */
  const cache = new Map()

  /** Read one cache entry, dropping it when stale. */
  const cached = (key) => {
    const entry = cache.get(key)
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > entry.ttl) {
      cache.delete(key)
      return undefined
    }
    return entry.value
  }

  /** Store one cache entry and evict the oldest when the map is full. */
  const remember = (key, value, ttl) => {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { value, at: Date.now(), ttl })
  }

  /** Run `git` in one directory and resolve its stdout, or null on any failure. */
  const git = (cwd, argv) =>
    new Promise((resolve) => {
      execFile(
        'git',
        argv,
        { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => resolve(error === null ? stdout : null),
      )
    })

  /** Annotate the two detached cases with `<sha>` / `<tag>` rather than a bare SHA. */
  const describeDetached = (head) => {
    const sha = /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : null
    return { branch: sha, detached: true, repo: true }
  }

  /**
   * Resolve the branch checked out in one directory.
   * @param {string} cwd - absolute Session working directory.
   * @returns {Promise<{ repo: boolean, branch: string | null, detached: boolean }>}
   */
  const readBranch = async (cwd) => {
    const resolved = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (resolved === null || resolved.trim() !== 'true') {
      // Not a work tree: still a repository when the directory is inside a bare
      // or `.git` path, and simply not versioned otherwise.
      const bare = await git(cwd, ['rev-parse', '--is-bare-repository'])
      return { repo: bare?.trim() === 'true', branch: null, detached: false }
    }
    const head = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (head !== null && head.trim() !== '') {
      return { repo: true, branch: head.trim(), detached: false }
    }
    const sha = await git(cwd, ['rev-parse', '--short', 'HEAD'])
    if (sha !== null && sha.trim() !== '') {
      return { repo: true, ...describeDetached(sha.trim()), detached: true }
    }
    // Repository without any commit yet: symbolic-ref already failed, so read
    // the unborn branch name from the config.
    const unborn = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (unborn !== null && unborn.trim() !== '' && unborn.trim() !== 'HEAD') {
      return { repo: true, branch: unborn.trim(), detached: false }
    }
    return { repo: true, branch: null, detached: false }
  }

  /**
   * Resolve one request's directory: cached, rejected when not absolute or
   * missing, and cached again on the way out.
   * @param {string} directory - directory reported by the browser half.
   * @param {boolean} fresh - bypass the cache (an explicit refresh).
   */
  const lookup = async (directory, fresh = false) => {
    if (!fresh) {
      const hit = cached(directory)
      if (hit !== undefined) return hit
    }
    let answer
    if (!isAbsolute(directory)) {
      answer = { repo: false, branch: null, detached: false, reason: 'invalid-directory' }
      remember(directory, answer, FAILURE_TTL_MS)
      return answer
    }
    let info
    try {
      info = await stat(directory)
    } catch {
      info = undefined
    }
    if (info === undefined || !info.isDirectory()) {
      answer = { repo: false, branch: null, detached: false, reason: 'missing-directory' }
      remember(directory, answer, FAILURE_TTL_MS)
      return answer
    }
    answer = await readBranch(directory)
    remember(directory, answer, answer.repo ? CACHE_TTL_MS : FAILURE_TTL_MS)
    return answer
  }

  /** Answer one HTTP request; every failure is JSON, never an HTML error page. */
  const handler = async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify(body))
    }

    if (request.method !== 'GET') return send(405, { error: 'method-not-allowed' })

    // Same-origin session cookie is the credential; `requestRejection` is the
    // Host's own answer for cross-site and unauthenticated requests.
    const connection = ctx.get('connection')
    if (typeof connection?.requestRejection === 'function') {
      let rejection
      try {
        rejection = connection.requestRejection(request)
      } catch (error) {
        ctx.logger.warn('git-branch-pill: requestRejection failed: %s', error)
        return send(503, { error: 'auth-unavailable' })
      }
      if (rejection !== undefined) return send(rejection, { error: 'unauthorized' })
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    const directory = url.searchParams.get('cwd') ?? url.searchParams.get('directory') ?? ''
    if (directory === '') return send(400, { error: 'missing-directory' })
    const fresh = url.searchParams.get('fresh') === '1'

    try {
      return send(200, await lookup(directory, fresh))
    } catch (error) {
      ctx.logger.warn('git-branch-pill: lookup failed: %s', error)
      return send(500, { error: 'lookup-failed' })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ENDPOINT, handler }))
}
