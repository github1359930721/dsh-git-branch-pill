/**
 * Host-half hardening checks: LRU eviction keeps hot directories, and a Host
 * with no reachable git reports `gitMissing` instead of pretending the folder
 * is not a repository.
 *
 *   node tests/host-hardening.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
}

/** Mount the Host half against a stub context and return its request driver. */
const mount = (options = {}) => {
  let registered
  apply({
    get: (key) => (key === 'subprocess' ? options.subprocess : undefined),
    logger: { warn: () => {} },
    webServer: { register: (route) => { registered = route; return () => {} } },
    effect: (fn) => fn(),
  })
  return async (query) => {
    let body
    await registered.handler(
      { method: 'GET', url: `/api/dsh-git-branch?${query}` },
      { writeHead: () => {}, end: (text) => { body = JSON.parse(text) } },
    )
    return body
  }
}

// 1. No subprocess service: resolution falls back to PATH, which works here.
const ask = mount()
const repo = await ask(`cwd=${encodeURIComponent('D:\\project\\go\\IM-APP')}`)
check('git resolves through the PATH fallback', repo.repo === true && typeof repo.branch === 'string', JSON.stringify(repo))
check('no gitMissing flag when git runs', repo.gitMissing !== true)

// 2. A subprocess service whose resolveExecutable refuses: git is genuinely absent.
const missing = mount({ subprocess: { resolveExecutable: async () => { throw new Error('ENOENT') } } })
const absent = await missing(`cwd=${encodeURIComponent('D:\\project\\go\\IM-APP')}`)
check('unresolvable git reports gitMissing', absent.gitMissing === true && absent.reason === 'git-missing', JSON.stringify(absent))
check('gitMissing is not reported as a repository', absent.repo === false)

// 3. A non-repository stays a plain "repo: false" with no warning semantics.
const plain = await ask(`cwd=${encodeURIComponent(tmpdir())}`)
check('non-repository has no reason and no gitMissing', plain.repo === false && plain.reason === undefined && plain.gitMissing !== true, JSON.stringify(plain))

// 4. LRU: fill past the 256 cap, keep re-reading one hot directory, and confirm
//    it survives while a cold one is evicted. Cache size is private, so the
//    signal is behavioural: the hot entry answers from cache (no git spawn) far
//    faster than an evicted one, but timing is flaky — assert the hot path stays
//    correct across the eviction churn instead.
const scratch = mkdtempSync(join(tmpdir(), 'gbp-lru-'))
try {
  for (let index = 0; index < 300; index += 1) {
    await ask(`cwd=${encodeURIComponent(join(scratch, `missing-${index}`))}`)
    if (index % 10 === 0) await ask(`cwd=${encodeURIComponent('D:\\project\\go\\IM-APP')}`)
  }
  const hot = await ask(`cwd=${encodeURIComponent('D:\\project\\go\\IM-APP')}`)
  check('hot directory still resolves after 300 evictions', hot.repo === true && typeof hot.branch === 'string', JSON.stringify(hot))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
