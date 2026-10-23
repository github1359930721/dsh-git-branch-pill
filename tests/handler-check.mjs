import { apply } from '../index.js'

let registered
const ctx = {
  get: () => undefined,
  logger: { warn: (...args) => console.error('[warn]', ...args) },
  webServer: {
    register: (route) => {
      registered = route
      return () => {}
    },
  },
  effect: (fn) => fn(),
}

apply(ctx)

const call = (url, method = 'GET') =>
  new Promise((resolve) => {
    const response = {
      writeHead: (status, headers) => {
        response._status = status
        response._headers = headers
      },
      end: (body) => resolve({ status: response._status, body: JSON.parse(body) }),
    }
    Promise.resolve(registered.handler({ method, url }, response))
  })

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ status: 'TIMEOUT' }), ms))])

const query = (cwd) => `/api/dsh-git-branch?cwd=${encodeURIComponent(cwd)}`

const cases = [
  ['own repo (IM-APP)', query('D:\\project\\go\\IM-APP'), 'GET', 'repo'],
  ['own repo (subdir)', query('D:\\project\\go\\IM-APP\\IM-APP-fronend'), 'GET', 'repo'],
  ['non-repo (home)', query('C:\\Users\\zbjt'), 'GET', 'no-repo'],
  ['missing dir', query('D:\\nope\\nope'), 'GET', 'no-repo'],
  ['relative dir', query('relative/path'), 'GET', 'no-repo'],
  ['no cwd param', '/api/dsh-git-branch', 'GET', 400],
  ['POST method', '/api/dsh-git-branch', 'POST', 405],
]

let failed = 0
for (const [name, url, method, kind] of cases) {
  const result = await withTimeout(call(url, method), 8000)
  if (result.status === 'TIMEOUT') {
    failed += 1
    console.log(`FAIL ${name}: timed out`)
    continue
  }
  const rendered = JSON.stringify(result)
  let ok
  if (kind === 'repo') {
    ok = result.status === 200 && result.body.repo === true && typeof result.body.branch === 'string' && result.body.branch !== ''
  } else if (kind === 'no-repo') {
    ok = result.status === 200 && result.body.repo === false && result.body.branch === null
  } else {
    ok = result.status === kind
  }
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${rendered}`)
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
