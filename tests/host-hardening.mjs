import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
}
const mount = (options = {}) => {
  let registered
  apply({
    get: key => key === 'connection' ? { requestRejection: () => undefined } : key === 'subprocess' ? options.subprocess : undefined,
    logger: { warn() {} },
    webServer: { register: route => { registered = route; return () => {} } },
    effect: fn => fn(),
  })
  return async cwd => {
    let body
    await registered.handler(
      { method: 'GET', url: `/api/dsh-git-branch?cwd=${encodeURIComponent(cwd)}` },
      { writeHead() {}, end: text => { body = JSON.parse(text) } },
    )
    return body
  }
}

const fixture = mkdtempSync(join(tmpdir(), 'gbp-hardening-'))
const repo = join(fixture, 'repo')
const plain = join(fixture, 'plain')
mkdirSync(repo)
mkdirSync(plain)
try {
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' })
  const ask = mount()
  const answer = await ask(repo)
  check('git resolves through PATH', answer.repo === true && answer.branch === 'main', JSON.stringify(answer))
  check('no gitMissing when git runs', answer.gitMissing !== true)

  const missing = mount({ subprocess: { resolveExecutable: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } } })
  const absent = await missing(repo)
  check('missing git is not mistaken for nonrepository', absent.gitMissing === true && absent.reason === 'git-missing', JSON.stringify(absent))
  check('missing git does not report repository', absent.repo === false)

  const nonrepo = await ask(plain)
  check('nonrepository has no error reason', nonrepo.repo === false && nonrepo.reason === undefined, JSON.stringify(nonrepo))

  for (let index = 0; index < 300; index++) {
    await ask(join(fixture, `missing-${index}`))
    if (index % 10 === 0) await ask(repo)
  }
  const hot = await ask(repo)
  check('hot directory still resolves after cache churn', hot.repo === true && hot.branch === 'main', JSON.stringify(hot))
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log(failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`)
process.exitCode = failures.length === 0 ? 0 : 1
