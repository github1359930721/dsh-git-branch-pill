import assert from 'node:assert/strict'
import test from 'node:test'
import { clientHarness, response, deferred, findNode } from './helpers/client-harness.mjs'

const branchAnswer = branch => response({ repo: true, branch, detached: false })
const menuItem = app => findNode(app.menu, node => node.type === 'button' && node.props['data-current'] === 'false')

test('late reads cannot overwrite a confirmed switch or remove its new request', async () => {
  const old = deferred()
  const confirmation = deferred()
  let calls = 0
  let staleSignal
  const app = clientHarness(async (url, options) => {
    if (url === '/git/config') return response({ ok: true, value: {} })
    if (url === '/git/branches') return response({ ok: true, value: { branches: [] } })
    calls++
    if (calls === 1) return branchAnswer('main')
    if (calls === 2) { staleSignal = options.signal; return old.promise }
    return confirmation.promise
  })
  try {
    await app.flush()
    await app.advance(3000)
    await app.openMenu()
    app.menuProps.onPicked('feature/new')
    await app.flush()
    assert.equal(staleSignal.aborted, true)
    assert.equal(app.button.props['data-git-branch'], 'feature/new')
    old.resolve(branchAnswer('main'))
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'feature/new')
    await app.advance(3000)
    assert.equal(calls, 3, 'old finally must not delete the replacement request')
    confirmation.resolve(branchAnswer('feature/new'))
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'feature/new')
  } finally { app.unmount() }
})

test('a foreground refresh supersedes an older ordinary poll', async () => {
  const old = deferred()
  let calls = 0
  let signal
  const app = clientHarness(async (url, options) => {
    if (url === '/git/config') return response({ ok: true, value: {} })
    calls++
    if (calls === 2) { signal = options.signal; return old.promise }
    return branchAnswer(calls === 1 ? 'main' : 'foreground')
  })
  try {
    await app.flush()
    await app.advance(3000)
    await app.visibility(true)
    await app.visibility(false)
    assert.equal(signal.aborted, true)
    assert.equal(app.button.props['data-git-branch'], 'foreground')
    old.resolve(branchAnswer('stale'))
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'foreground')
  } finally { app.unmount() }
})

test('slow lookups are shared across ticks rather than stacked', async () => {
  const pending = deferred()
  let calls = 0
  const app = clientHarness(async url => {
    if (url === '/git/config') return response({ ok: true, value: {} })
    calls++
    return pending.promise
  })
  try {
    await app.flush()
    await app.advance(3000)
    assert.equal(calls, 1)
    pending.resolve(branchAnswer('main'))
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'main')
  } finally { app.unmount() }
})

test('old directory responses do not update the current directory', async () => {
  const old = deferred()
  const app = clientHarness(async url => {
    if (url === '/git/config') return response({ ok: true, value: {} })
    return url.includes(encodeURIComponent('/workspace/repo')) ? old.promise : branchAnswer('other')
  })
  try {
    await app.flush()
    await app.changeDirectory('/workspace/other')
    old.resolve(branchAnswer('main'))
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'other')
  } finally { app.unmount() }
})

test('real menu callbacks reject duplicate switches and close with focus restored', async () => {
  const switching = deferred()
  let branch = 'main'
  let switches = 0
  const app = clientHarness(async url => {
    if (url === '/git/config') return response({ ok: true, value: {} })
    if (url === '/git/branches') return response({ ok: true, value: { branches: [{ name: 'main' }, { name: 'feature' }] } })
    if (url === '/git/switch') { switches++; return switching.promise }
    return branchAnswer(branch)
  })
  try {
    await app.flush()
    await app.openMenu()
    const input = findNode(app.menu, node => node.type === 'input')
    assert.equal(input.props['aria-label'], 'Filter branches')
    const item = menuItem(app)
    item.props.onClick()
    item.props.onClick()
    await app.flush()
    assert.equal(switches, 1)
    branch = 'feature'
    switching.resolve(response({ ok: true, value: { branch } }))
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], branch)
    assert.equal(app.menu, undefined)
    assert.equal(app.focused.at(-1), 'button')
  } finally { app.unmount() }
  assert.equal(app.timerCount, 0)
  assert.equal(app.listenerCount, 0)
})

test('late switch results cannot change a different directory or reopen a closed menu', async () => {
  for (const action of ['directory', 'close', 'unmount']) {
    const switching = deferred()
    const app = clientHarness(async url => {
      if (url === '/git/config') return response({ ok: true, value: {} })
      if (url === '/git/branches') return response({ ok: true, value: { branches: [{ name: 'feature' }] } })
      if (url === '/git/switch') return switching.promise
      return branchAnswer(url.includes(encodeURIComponent('/workspace/other')) ? 'other' : 'main')
    })
    try {
      await app.flush()
      await app.openMenu()
      menuItem(app).props.onClick()
      await app.flush()
      if (action === 'directory') await app.changeDirectory('/workspace/other')
      else if (action === 'close') await app.key('Escape')
      else app.unmount()
      switching.resolve(response({ ok: true, value: { branch: 'feature' } }))
      await app.flush()
      assert.equal(app.menu, undefined)
      assert.equal(app.button.props['data-git-branch'], action === 'directory' ? 'other' : 'main')
    } finally { app.unmount() }
  }
})

test('failed switches remain visible and can be retried', async () => {
  const app = clientHarness(async url => {
    if (url === '/git/config') return response({ ok: true, value: {} })
    if (url === '/git/branches') return response({ ok: true, value: { branches: [{ name: 'feature' }] } })
    if (url === '/git/switch') return response({ ok: false, error: { message: 'uncommitted changes' } })
    return branchAnswer('main')
  })
  try {
    await app.flush()
    await app.openMenu()
    menuItem(app).props.onClick()
    await app.flush()
    const alert = findNode(app.menu, node => node.props.role === 'alert')
    assert.match(alert.props.children, /uncommitted changes/)
    assert.equal(menuItem(app).props.disabled, false)
    await app.outside()
    assert.equal(app.menu, undefined)
  } finally { app.unmount() }
})

test('invalid lookup payload is unknown, not a nonrepository', async () => {
  const app = clientHarness(async url => response(url === '/git/config' ? { ok: true, value: {} } : { unexpected: true }))
  try {
    await app.flush()
    assert.equal(app.tree.props.state, 'error')
  } finally { app.unmount() }
})

test('clipboard success and failure both have visible, temporary feedback', async () => {
  for (const succeeds of [true, false]) {
    const app = clientHarness(async url => url === '/git/config' ? response({ ok: true, value: {} }) : branchAnswer('main'), {
      clipboard: { writeText: async name => { assert.equal(name, 'main'); if (!succeeds) throw new Error('denied') } },
    })
    try {
      await app.flush()
      await app.copy()
      assert.equal(app.button.props['data-state'], succeeds ? 'copied' : 'error')
      await app.advance(1200)
      assert.equal(app.button.props['data-state'], 'ready')
    } finally { app.unmount() }
    assert.equal(app.timerCount, 0)
  }
})

test('a disappearing bridge closes the menu and recovery does not reopen it', async () => {
  let available = true
  const app = clientHarness(async url => {
    if (url === '/git/config') { if (!available) throw new Error('removed'); return response({ ok: true, value: {} }) }
    if (url === '/git/branches') return response({ ok: true, value: { branches: [] } })
    return branchAnswer('main')
  })
  try {
    await app.flush()
    await app.openMenu()
    assert.ok(app.menu)
    available = false
    await app.advance(60000)
    assert.equal(app.menu, undefined)
    assert.equal(app.button.props['data-switchable'], 'false')
    available = true
    await app.online()
    assert.equal(app.button.props['data-switchable'], 'true')
    assert.equal(app.menu, undefined)
  } finally { app.unmount() }
})

test('superseded bridge probes cannot restore a stale capability result', async () => {
  const old = deferred()
  let probes = 0
  const app = clientHarness(async url => {
    if (url === '/git/config') { probes++; return probes === 1 ? old.promise : response({ ok: true, value: {} }) }
    return branchAnswer('main')
  })
  try {
    await app.flush()
    await app.online()
    assert.equal(app.button.props['data-switchable'], 'true')
    old.reject(new Error('late offline result'))
    await app.flush()
    assert.equal(app.button.props['data-switchable'], 'true')
    assert.equal(probes, 2)
  } finally { app.unmount() }
})

test('hidden mount performs no requests until shown', async () => {
  let calls = 0
  const app = clientHarness(async url => {
    calls++
    return url === '/git/config' ? response({ ok: true, value: {} }) : branchAnswer('main')
  }, { hidden: true })
  try {
    await app.flush()
    await app.advance(6000)
    assert.equal(calls, 0)
    await app.visibility(false)
    assert.equal(calls, 2)
    assert.equal(app.button.props['data-git-branch'], 'main')
  } finally { app.unmount() }
})

test('polling reads an external branch change, pauses while hidden, and forces a foreground refresh', async () => {
  let branch = 'main'
  const requests = []
  const app = clientHarness(async url => {
    if (url === '/git/config') return response({ ok: true, value: {} })
    requests.push(url)
    return response({ repo: true, branch, detached: false })
  })
  try {
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'main')
    assert.match(requests[0], /fresh=1/)
    branch = 'feature/external'
    await app.advance(3000)
    assert.equal(app.button.props['data-git-branch'], branch)
    assert.equal(requests.length, 2)
    assert.doesNotMatch(requests[1], /fresh=1/)
    await app.visibility(true)
    await app.advance(12000)
    assert.equal(requests.length, 2)
    branch = 'feature/foreground'
    await app.visibility(false)
    assert.equal(app.button.props['data-git-branch'], branch)
    assert.equal(requests.length, 3)
    assert.match(requests[2], /fresh=1/)
  } finally {
    app.unmount()
  }
  assert.equal(app.timerCount, 0)
  assert.equal(app.listenerCount, 0)
})

test('bridge failures expire and switching becomes available without remounting', async () => {
  let available = false
  let probes = 0
  const app = clientHarness(async url => {
    if (url === '/git/config') {
      probes++
      if (!available) throw new Error('temporary disconnect')
      return response({ ok: true, value: {} })
    }
    return response({ repo: true, branch: 'main', detached: false })
  })
  try {
    await app.flush()
    assert.equal(app.button.props['data-switchable'], 'false')
    available = true
    await app.advance(3000)
    assert.equal(probes, 1, 'failed probes are throttled')
    await app.advance(12000)
    assert.equal(app.button.props['data-switchable'], 'true')
    assert.equal(probes, 2)
    available = false
    await app.advance(60000)
    assert.equal(app.button.props['data-switchable'], 'false', 'removing the bridge also recovers to copy-only')
  } finally {
    app.unmount()
  }
})

test('network recovery refreshes both the branch and a previously failed bridge immediately', async () => {
  let online = false
  const app = clientHarness(async url => {
    if (!online) throw new Error('offline')
    return response(url === '/git/config' ? { ok: true, value: {} } : { repo: true, branch: 'recovered', detached: false })
  })
  try {
    await app.flush()
    online = true
    await app.online()
    assert.equal(app.button?.props['data-git-branch'], 'recovered')
    assert.equal(app.button?.props['data-switchable'], 'true')
  } finally {
    app.unmount()
  }
})

for (const reason of ['git-missing', 'git-timeout', 'git-permission-denied', 'git-failed', 'directory-permission-denied', 'directory-unavailable']) {
  test(`${reason} renders a warning and can recover on a later poll`, async () => {
    let recovered = false
    const app = clientHarness(async url => response(url === '/git/config'
      ? { ok: true, value: {} }
      : recovered ? { repo: true, branch: 'main', detached: false }
        : { repo: false, branch: null, detached: false, reason, gitMissing: reason === 'git-missing' }))
    try {
      await app.flush()
      assert.equal(app.tree.props.state, 'error')
      recovered = true
      await app.advance(3000)
      assert.equal(app.button?.props['data-git-branch'], 'main')
    } finally {
      app.unmount()
    }
  })
}
