import test from 'node:test'
import assert from 'node:assert/strict'
import { mountHost, directory } from './helpers/host-harness.mjs'
const url = `/api/dsh-git-status?cwd=${encodeURIComponent(directory)}`
const ask = (host, fresh = false) => host.ask(directory, { url: `${url}${fresh ? '&fresh=1' : ''}` })

test('NUL status parsing counts modifications, untracked, conflicts and renames once', async () => {
  const host = await mountHost({ git: () => ({ stdout: ' M file with spaces\0?? line\nbreak\0UU conflict\0R  new name\0old name\0' }) })
  assert.deepEqual((await ask(host)).body, { repo: true, dirty: true, modifiedFiles: 2, untrackedFiles: 1, conflicts: 1 })
  assert.ok(host.calls[0].argv.includes('--no-optional-locks'))
  assert.ok(host.calls[0].argv.includes('-z'))
})
test('clean worktree and nonrepository remain distinct', async () => {
  const clean = await mountHost({ git: () => ({ stdout: '' }) })
  assert.equal((await ask(clean)).body.dirty, false)
  const absent = await mountHost({ git: () => ({ error: Object.assign(new Error('not repo'), { code: 128 }), stderr: 'fatal: not a git repository (or any of the parent directories): .git' }) })
  assert.equal((await ask(absent)).body.repo, false)
})
test('status cache is thirty seconds and independent of branch cache', async () => {
  const host = await mountHost({ git: call => call.argv.includes('status') ? { stdout: '' } : call.argv[0] === 'symbolic-ref' ? { stdout: 'main\n' } : { stdout: 'true\nfalse\n' } })
  await ask(host)
  await host.ask()
  assert.equal(host.calls.length, 3)
  await host.advance(29000)
  await ask(host)
  assert.equal(host.calls.length, 3)
  await host.advance(1000)
  await ask(host)
  assert.equal(host.calls.length, 4)
  await ask(host, true)
  assert.equal(host.calls.length, 5)
})
test('status never bypasses auth and malformed output is not clean', async () => {
  const denied = await mountHost({ connection: { requestRejection: () => 401 } })
  assert.equal((await ask(denied)).status, 401)
  assert.equal(denied.calls.length, 0)
  const malformed = await mountHost({ git: () => ({ stdout: 'R  missing-source\0' }) })
  assert.equal((await ask(malformed)).body.reason, 'git-failed')
})
