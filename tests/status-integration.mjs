import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

test('real status endpoint reports clean, modified, renamed and untracked files in a temporary repo', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'gbp-status-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  const routes = new Map()
  apply({
    get: key => key === 'connection' ? { requestRejection: () => undefined } : undefined,
    logger: { warn() {} }, effect: fn => fn(),
    webServer: { register: route => { routes.set(route.path, route); return () => {} } },
  })
  const ask = async () => {
    let result
    await routes.get('/api/dsh-git-status').handler({ method: 'GET', url: `/api/dsh-git-status?cwd=${encodeURIComponent(repo)}&fresh=1` }, { writeHead() {}, end: text => { result = JSON.parse(text) } })
    return result
  }
  try {
    git('init', '--initial-branch=main')
    git('config', 'user.name', 'pill')
    git('config', 'user.email', 'pill@example.test')
    writeFileSync(join(repo, 'tracked.txt'), 'initial')
    writeFileSync(join(repo, 'rename.txt'), 'rename')
    git('add', '.')
    git('commit', '-m', 'fixture')
    assert.equal((await ask()).dirty, false)
    writeFileSync(join(repo, 'tracked.txt'), 'changed')
    git('mv', 'rename.txt', 'renamed file.txt')
    writeFileSync(join(repo, 'untracked file.txt'), 'new')
    assert.deepEqual(await ask(), { repo: true, dirty: true, modifiedFiles: 2, untrackedFiles: 1, conflicts: 0 })
  } finally { await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
