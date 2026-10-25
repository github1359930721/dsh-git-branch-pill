import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const fixture = mkdtempSync(join(tmpdir(), 'gbp-handler-'))
const repo = join(fixture, 'repo')
const subdir = join(repo, 'subdir')
const plain = join(fixture, 'plain')
mkdirSync(repo)
mkdirSync(subdir)
mkdirSync(plain)

let registered
apply({
  get: key => key === 'connection' ? { requestRejection: () => undefined } : undefined,
  logger: { warn: (...args) => console.error('[warn]', ...args) },
  webServer: { register: route => { registered = route; return () => {} } },
  effect: fn => fn(),
})

const call = async (url, method = 'GET') => {
  let status, body
  await registered.handler({ method, url }, {
    writeHead: code => { status = code },
    end: text => { body = JSON.parse(text) },
  })
  return { status, body }
}
const query = cwd => `/api/dsh-git-branch?cwd=${encodeURIComponent(cwd)}`
let failed = 0
try {
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' })
  const cases = [
    ['repository', query(repo), 'GET', 'main'],
    ['repository subdirectory', query(subdir), 'GET', 'main'],
    ['nonrepository', query(plain), 'GET', 'plain'],
    ['missing directory', query(join(fixture, 'missing')), 'GET', 'missing-directory'],
    ['relative directory', query('relative/path'), 'GET', 'invalid-directory'],
    ['no cwd', '/api/dsh-git-branch', 'GET', 400],
    ['POST', '/api/dsh-git-branch', 'POST', 405],
  ]
  for (const [name, url, method, expected] of cases) {
    const result = await call(url, method)
    const ok = typeof expected === 'number' ? result.status === expected
      : expected === 'main' ? result.status === 200 && result.body.repo === true && result.body.branch === 'main'
        : expected === 'plain' ? result.status === 200 && result.body.repo === false && result.body.reason === undefined
          : result.status === 200 && result.body.reason === expected
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(result)}`)
  }
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
