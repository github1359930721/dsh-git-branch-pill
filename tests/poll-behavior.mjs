/**
 * Branch-switch behaviour: repeated lookups must overwrite a cached answer, and
 * `?fresh=1` must bypass the Host cache. Runs both halves against a real repo
 * in a throwaway worktree-free fixture: it switches a temporary branch and reads
 * again through the Host handler.
 *
 *   node tests/poll-behavior.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const repo = mkdtempSync(join(tmpdir(), 'gbp-poll-'))
const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
}

try {
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'pill@example.test')
  git(repo, 'config', 'user.name', 'pill')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
  check('fixture repo created', git(repo, 'branch', '--show-current') === 'main')

  // Mount the Host half against a stub context, then drive its handler.
  let registered
  apply({
    get: () => undefined,
    logger: { warn: (...args) => console.error('[warn]', ...args) },
    webServer: {
      register: (route) => {
        registered = route
        return () => {}
      },
    },
    effect: (fn) => fn(),
  })

  const ask = (fresh) =>
    new Promise((resolve) => {
      const response = {
        writeHead: () => {},
        end: (body) => resolve(JSON.parse(body)),
      }
      const suffix = fresh ? '&fresh=1' : ''
      Promise.resolve(registered.handler({ method: 'GET', url: `/api/dsh-git-branch?cwd=${encodeURIComponent(repo)}${suffix}` }, response))
    })

  const first = await ask()
  check('first lookup reports main', first.branch === 'main', JSON.stringify(first))

  git(repo, 'checkout', '-b', 'feature/switch')
  const cached = await ask()
  check('cached answer still says main (inside the TTL)', cached.branch === 'main', JSON.stringify(cached))

  const forced = await ask(true)
  check('fresh=1 sees feature/switch immediately', forced.branch === 'feature/switch', JSON.stringify(forced))

  // Wait out the 2s TTL: a polling page must see the switch without ?fresh.
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const polled = await ask()
  check('poll after the TTL sees feature/switch', polled.branch === 'feature/switch', JSON.stringify(polled))

  git(repo, 'checkout', '--detach', 'HEAD')
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const detached = await ask()
  check('detached HEAD reports a sha, not a branch', detached.detached === true && /^[0-9a-f]{7}$/.test(detached.branch ?? ''), JSON.stringify(detached))
} finally {
  try {
    rmSync(repo, { recursive: true, force: true })
  } catch {
    /* the fixture lives under the OS temp root; a locked file is harmless */
  }
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
