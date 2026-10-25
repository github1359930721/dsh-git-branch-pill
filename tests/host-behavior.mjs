import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mountHost, directory, deferred } from './helpers/host-harness.mjs'

const error = (code, message = String(code)) => Object.assign(new Error(message), { code })
const body = async (host, cwd = directory, options) => (await host.ask(cwd, options)).body
const delayed = (call, delay) => ({ delay, stdout: call.argv[0] === 'symbolic-ref' ? 'main\n' : 'true\nfalse\n' })

for (const [name, git, expected] of [
  ['normal branch', undefined, { repo: true, branch: 'main', detached: false }],
  ['unborn branch', (call) => call.argv[0] === 'symbolic-ref' ? { stdout: 'new-empty\n' } : { stdout: 'true\nfalse\n' }, { repo: true, branch: 'new-empty', detached: false }],
  ['bare repository', () => ({ stdout: 'false\ntrue\n' }), { repo: true, branch: null, detached: false }],
  ['inside .git', () => ({ stdout: 'false\nfalse\n' }), { repo: false, branch: null, detached: false }],
  ['nonrepository', () => ({ error: error(128), stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }), { repo: false, branch: null, detached: false }],
]) {
  test(name, async () => {
    const host = await mountHost({ git })
    assert.deepEqual(await body(host), expected)
    assert.equal(host.calls.length, expected.branch ? 2 : 1)
    assert.equal(host.active.size, 0)
    assert.equal(host.timerCount, 0)
  })
}

test('detached HEAD is the only symbolic-ref exit 1 treated as normal', async () => {
  const host = await mountHost({ git: (call) => {
    if (call.argv[0] === 'symbolic-ref') return { error: error(1) }
    if (call.argv.includes('--short')) return { stdout: 'abcdef012345\n' }
    return { stdout: 'true\nfalse\n' }
  } })
  assert.deepEqual(await body(host), { repo: true, branch: 'abcdef0', detached: true })
  assert.equal(host.calls.length, 3)
})

for (const [name, result, reason] of [
  ['spawn ENOENT', { error: error('ENOENT') }, 'git-missing'],
  ['spawn EACCES', { error: error('EACCES') }, 'git-permission-denied'],
  ['spawn EPERM', { error: error('EPERM') }, 'git-permission-denied'],
  ['safe.directory fence', { error: error(128), stderr: "fatal: detected dubious ownership in repository at 'fixture'\nTo add an exception, call git config --global --add safe.directory fixture" }, 'git-permission-denied'],
  ['Git filesystem permission', { error: error(128), stderr: 'fatal: cannot chdir to fixture: Permission denied\n' }, 'git-permission-denied'],
  ['unknown exit 128', { error: error(128), stderr: 'fatal: corrupt repository\n' }, 'git-failed'],
  ['maxBuffer', { error: error('ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }, 'git-failed'],
  ['external termination', { error: Object.assign(error(null), { signal: 'SIGTERM' }) }, 'git-failed'],
  ['synchronous spawn failure', { throw: error('EACCES') }, 'git-permission-denied'],
]) {
  test(name, async () => {
    const host = await mountHost({ git: () => result })
    const answer = await body(host)
    assert.equal(answer.reason, reason)
    assert.equal(answer.gitMissing === true, reason === 'git-missing')
    assert.equal(host.calls.length, 1)
    assert.equal(host.timerCount, 0)
  })
}

test('errors in HEAD commands do not masquerade as detached or empty', async () => {
  for (const result of [{ error: error(128), stderr: 'fatal: corrupt HEAD' }, { error: error(1), stderr: 'permission diagnostic' }, { stdout: '' }]) {
    const host = await mountHost({ git: (call) => call.argv[0] === 'symbolic-ref' ? result : { stdout: 'true\nfalse\n' } })
    assert.equal((await body(host)).reason, 'git-failed')
    assert.equal(host.calls.length, 2)
  }
  const host = await mountHost({ git: (call) => call.argv[0] === 'symbolic-ref' ? { error: error(1) }
    : call.argv.includes('--short') ? { error: error(128), stderr: 'fatal: broken object' } : { stdout: 'true\nfalse\n' } })
  assert.equal((await body(host)).reason, 'git-failed')
  assert.equal(host.calls.length, 3)
})

test('missing, inaccessible, unavailable and non-directory stat results remain distinct', async () => {
  for (const [code, reason] of [['ENOENT', 'missing-directory'], ['ENOTDIR', 'missing-directory'], ['EACCES', 'directory-permission-denied'], ['EPERM', 'directory-permission-denied'], ['EIO', 'directory-unavailable']]) {
    const host = await mountHost({ stat: async () => { throw error(code) } })
    assert.equal((await body(host)).reason, reason)
    assert.equal(host.calls.length, 0)
    assert.equal(host.resolutions.length, 0)
  }
  const host = await mountHost({ stat: async () => ({ isDirectory: () => false }) })
  assert.equal((await body(host)).reason, 'missing-directory')
  assert.equal((await body(host, 'relative')).reason, 'invalid-directory')
  assert.equal(host.stats.length, 1)
})

test('total four-second deadline includes stalled executable resolution', async () => {
  const pending = deferred()
  const host = await mountHost({ resolveExecutable: () => pending.promise })
  const request = host.request()
  await host.advance(3999)
  assert.equal(host.calls.length, 0)
  assert.equal(host.resolutions.length, 1)
  await host.advance(1)
  assert.equal((await request.done).body.reason, 'git-timeout')
  pending.resolve('late-git')
  await host.flush()
  assert.equal(host.calls.length, 0)
  assert.equal(host.timerCount, 0)
  assert.equal((await body(host)).branch, 'main')
  assert.equal(host.resolutions.length, 2)
})

test('total deadline includes stat and prevents late commands', async () => {
  const pending = deferred()
  const host = await mountHost({ stat: () => pending.promise })
  const request = host.request()
  await host.advance(4000)
  assert.equal((await request.done).body.reason, 'git-timeout')
  pending.resolve({ isDirectory: () => true })
  await host.flush()
  assert.equal(host.resolutions.length, 0)
  assert.equal(host.calls.length, 0)
})

test('resolution and serial commands share one budget and kill the active child', async () => {
  const pending = deferred()
  const host = await mountHost({ resolveExecutable: () => pending.promise, git: (call) => delayed(call, call.argv[0] === 'symbolic-ref' ? 3000 : 1000) })
  const request = host.request()
  await host.advance(1000)
  pending.resolve('mock-git')
  await host.flush()
  assert.equal(host.calls[0].config.timeout, 3000)
  await host.advance(1000)
  assert.equal(host.calls[1].config.timeout, 2000)
  await host.advance(2000)
  assert.equal((await request.done).body.reason, 'git-timeout')
  assert.equal(host.kills.length, 1)
  assert.equal(host.kills[0].signal, 'SIGKILL')
  assert.equal(host.active.size, 0)
  assert.equal(host.timerCount, 0)
  await host.advance(5000)
  assert.equal(host.calls.length, 2)
})

test('resolver failures have a retry TTL instead of permanent negative cache', async () => {
  let available = false
  const host = await mountHost({ resolveExecutable: () => {
    if (!available) throw error('ENOENT')
    return 'repaired-git'
  } })
  assert.equal((await body(host)).reason, 'git-missing')
  available = true
  await host.advance(7999)
  assert.equal((await body(host, directory, { fresh: true })).reason, 'git-missing')
  assert.equal(host.resolutions.length, 1)
  await host.advance(1)
  assert.equal((await body(host, directory, { fresh: true })).branch, 'main')
  assert.equal(host.resolutions.length, 2)
})

test('host executable-not-found diagnostics are classified as missing Git', async () => {
  const host = await mountHost({ resolveExecutable: () => { throw Object.assign(new Error('git was not found on PATH'), { name: 'SubprocessExecutableNotFoundError' }) } })
  const answer = await body(host)
  assert.equal(answer.reason, 'git-missing')
  assert.equal(answer.gitMissing, true)
  assert.equal(host.calls.length, 0)
})

test('resolver permission and unknown failures remain distinct; empty resolution is missing', async () => {
  for (const [value, reason] of [[error('EACCES'), 'git-permission-denied'], [error('EPERM'), 'git-permission-denied'], [error('EIO'), 'git-failed'], ['', 'git-missing'], [null, 'git-missing']]) {
    const host = await mountHost({ resolveExecutable: () => { if (value instanceof Error) throw value; return value } })
    assert.equal((await body(host)).reason, reason)
    assert.equal(host.calls.length, 0)
  }
})

test('spawn ENOENT invalidates successful executable resolution, then retries after TTL', async () => {
  let available = false
  const host = await mountHost({ git: (call) => available ? delayed(call, 0) : { error: error('ENOENT') } })
  assert.equal((await body(host)).reason, 'git-missing')
  available = true
  assert.equal((await body(host, join(directory, 'other'))).reason, 'git-missing')
  assert.equal(host.calls.length, 1)
  await host.advance(8000)
  assert.equal((await body(host)).branch, 'main')
  assert.equal(host.resolutions.length, 2)
})

test('PATH fallback remains compatible without subprocess', async () => {
  const host = await mountHost({ subprocess: false })
  assert.equal((await body(host)).branch, 'main')
  assert.equal(host.calls[0].executable, 'git')
  assert.equal(host.calls[0].config.env.LC_ALL, 'C')
  assert.equal(host.calls[0].config.env.GIT_TERMINAL_PROMPT, '0')
})

test('normalized directory cache and in-flight requests deduplicate', async () => {
  const host = await mountHost({ git: (call) => delayed(call, 100) })
  const a = host.request(directory)
  const b = host.request(`${directory}/./`)
  await host.advance(200)
  assert.equal((await a.done).body.branch, 'main')
  assert.equal((await b.done).body.branch, 'main')
  assert.equal(host.stats.length, 1)
  assert.equal(host.calls.length, 2)
  assert.equal((await body(host, `${directory}/sub/..`)).branch, 'main')
  assert.equal(host.calls.length, 2)
  await host.advance(2000)
  const next = host.request()
  await host.advance(200)
  assert.equal((await next.done).body.branch, 'main')
  assert.equal(host.calls.length, 4)
})

test('fresh bypasses settled cache and concurrent fresh calls share one query', async () => {
  let branch = 'main'
  const host = await mountHost({ git: (call) => ({ delay: 100, stdout: call.argv[0] === 'symbolic-ref' ? `${branch}\n` : 'true\nfalse\n' }) })
  const first = host.request()
  await host.advance(200)
  await first.done
  branch = 'feature'
  assert.equal((await body(host)).branch, 'main')
  const a = host.request(directory, { fresh: true }), b = host.request(directory, { fresh: true })
  await host.advance(200)
  assert.equal((await a.done).body.branch, 'feature')
  assert.equal((await b.done).body.branch, 'feature')
  assert.equal(host.calls.length, 4)
  assert.equal((await body(host)).branch, 'feature')
})

test('fresh does not reuse an older in-flight ordinary query', async () => {
  let reads = 0
  const host = await mountHost({ git: (call) => ({ delay: 100, stdout: call.argv[0] === 'symbolic-ref' ? `${++reads === 1 ? 'old' : 'new'}\n` : 'true\nfalse\n' }) })
  const old = host.request()
  await host.flush()
  const a = host.request(directory, { fresh: true }), b = host.request(directory, { fresh: true })
  await host.advance(400)
  assert.equal((await old.done).body.branch, 'old')
  assert.equal((await a.done).body.branch, 'new')
  assert.equal((await b.done).body.branch, 'new')
  assert.equal(host.calls.length, 4)
})

test('fresh waiting behind an ordinary query still has only four seconds', async () => {
  const host = await mountHost({ git: (call) => delayed(call, 1500) })
  const old = host.request()
  await host.flush()
  const fresh = host.request(directory, { fresh: true })
  await host.advance(4000)
  assert.equal((await old.done).body.branch, 'main')
  assert.equal((await fresh.done).body.reason, 'git-timeout')
  assert.equal(host.calls.length, 3)
  assert.equal(host.active.size, 0)
  assert.equal(host.kills.length, 1)
})

for (const mode of ['abort', 'close']) {
  test(`${mode}: last disconnected caller kills Git and does not cache or send`, async () => {
    const host = await mountHost({ git: (call) => delayed(call, 100) })
    const request = host.request()
    await host.flush()
    assert.equal(host.active.size, 1)
    request[mode]()
    await host.flush()
    assert.equal(await request.done, undefined)
    assert.equal(host.kills.length, 1)
    assert.equal(host.active.size, 0)
    assert.equal(host.timerCount, 0)
    const next = host.request()
    await host.advance(200)
    assert.equal((await next.done).body.branch, 'main')
    assert.equal(host.calls.length, 3)
  })
}

test('one shared caller disconnecting does not kill the surviving caller', async () => {
  const host = await mountHost({ git: (call) => delayed(call, 100) })
  const a = host.request(), b = host.request()
  await host.flush()
  a.close()
  await host.advance(200)
  assert.equal(await a.done, undefined)
  assert.equal((await b.done).body.branch, 'main')
  assert.equal(host.kills.length, 0)
  assert.equal(host.calls.length, 2)
  assert.equal(a.req.listenerCount('aborted'), 0)
  assert.equal(b.res.listenerCount('close'), 0)
})

test('disconnect during executable resolution prevents any late Git invocation', async () => {
  const pending = deferred()
  const host = await mountHost({ resolveExecutable: () => pending.promise })
  const request = host.request()
  await host.flush()
  request.abort()
  await host.flush()
  assert.equal(await request.done, undefined)
  pending.resolve('late-git')
  await host.flush()
  assert.equal(host.calls.length, 0)
  assert.equal(host.timerCount, 0)
})

test('normal completed GET close does not cancel, incomplete request close does', async () => {
  const host = await mountHost({ git: (call) => delayed(call, 100) })
  const normal = host.request()
  await host.flush()
  normal.req.emit('close')
  await host.advance(200)
  assert.equal((await normal.done).body.branch, 'main')
  assert.equal(host.kills.length, 0)
  const incomplete = host.request(directory, { fresh: true })
  await host.flush()
  incomplete.req.complete = false
  incomplete.req.emit('close')
  await host.flush()
  assert.equal(await incomplete.done, undefined)
  assert.equal(host.kills.length, 1)
})

test('Host lifecycle cleanup aborts active processes', async () => {
  const host = await mountHost({ git: (call) => delayed(call, 100) })
  const request = host.request()
  await host.flush()
  host.dispose()
  await host.flush()
  await request.done
  assert.equal(host.active.size, 0)
  assert.equal(host.timerCount, 0)
  assert.equal(host.kills.length, 1)
})

test('missing authentication capability fails closed without querying directories', async () => {
  for (const connection of [false, {}]) {
    const host = await mountHost({ connection })
    const result = await host.ask()
    assert.equal(result.status, 503)
    assert.equal(result.body.error, 'auth-unavailable')
    assert.equal(host.stats.length, 0)
    assert.equal(host.calls.length, 0)
  }
})

for (const status of [401, 403]) {
  test(`requestRejection ${status} never resolves or runs Git`, async () => {
    const host = await mountHost({ connection: { requestRejection: () => status } })
    assert.equal((await host.ask()).status, status)
    assert.equal(host.stats.length, 0)
    assert.equal(host.resolutions.length, 0)
    assert.equal(host.calls.length, 0)
  })
}

test('requestRejection throw returns auth-unavailable without Git', async () => {
  const host = await mountHost({ connection: { requestRejection: () => { throw new Error('auth failed') } } })
  const result = await host.ask()
  assert.equal(result.status, 503)
  assert.equal(result.body.error, 'auth-unavailable')
  assert.equal(host.stats.length, 0)
  assert.equal(host.calls.length, 0)
  assert.equal(host.resolutions.length, 0)
})

test('requestRejection undefined admits; method and missing cwd checks still work', async () => {
  const host = await mountHost({ connection: { requestRejection: () => undefined } })
  assert.equal((await body(host)).branch, 'main')
  assert.equal((await host.ask(directory, { method: 'POST' })).status, 405)
  assert.equal((await host.ask(directory, { url: '/api/dsh-git-branch' })).status, 400)
})

test('cache LRU keeps a hot entry and evicts the oldest cold entry at 256', async () => {
  const host = await mountHost()
  const hot = join(directory, 'hot'), cold = join(directory, 'cold')
  await host.ask(hot)
  await host.ask(cold)
  for (let index = 0; index < 255; index += 1) {
    await host.ask(join(directory, `entry-${index}`))
    await host.ask(hot)
  }
  const count = host.calls.length
  await host.ask(hot)
  assert.equal(host.calls.length, count)
  await host.ask(cold)
  assert.equal(host.calls.length, count + 2)
})
