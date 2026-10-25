import test from 'node:test'
import assert from 'node:assert/strict'
import { clientHarness, response, deferred, findNode } from './helpers/client-harness.mjs'

const branch = name => response({ repo: true, branch: name, detached: false })
const refresh = app => app.tree.props.onRefresh?.() ?? app.tree.children[2].props.onClick()
const bridge = response({ ok: true, value: {} })

test('manual refresh preserves label, shows pending state and bypasses cache', async () => {
  const pending = deferred()
  const requests = []
  const app = clientHarness(async url => {
    if (url === '/git/config') return bridge
    requests.push(url)
    return requests.length === 1 ? branch('main') : pending.promise
  })
  try {
    await app.flush()
    refresh(app)
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'main')
    assert.equal(app.button.props['aria-busy'], true)
    assert.match(requests[1], /fresh=1/)
    pending.resolve(branch('feature'))
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'feature')
    assert.equal(app.button.props['aria-busy'], false)
  } finally { app.unmount() }
})

for (const succeeds of [true, false]) {
  test(`manual refresh stays busy through polls until status ${succeeds ? 'succeeds' : 'fails'}`, async () => {
    const pendingBranch = deferred()
    const pendingStatus = deferred()
    let branchCalls = 0
    const statusRequests = []
    const app = clientHarness(async url => {
      if (url === '/git/config') return bridge
      if (url === '/git/branches') return response({ ok: true, value: { branches: [] } })
      return ++branchCalls === 2 ? pendingBranch.promise : branch('main')
    }, {
      statusFetch: async url => {
        statusRequests.push(url)
        return statusRequests.length === 1
          ? response({ repo: true, dirty: false, modifiedFiles: 0, untrackedFiles: 0, conflicts: 0 })
          : pendingStatus.promise
      },
    })
    try {
      await app.flush()
      await app.openMenu()
      const completion = refresh(app)
      let completed = false
      completion.then(() => { completed = true })
      await app.advance(3000)
      assert.equal(app.button.props['aria-busy'], true)
      pendingBranch.resolve(branch('main'))
      await app.flush()
      assert.equal(statusRequests.length, 2)
      assert.match(statusRequests[1], /fresh=1/)
      await app.advance(3000)
      assert.equal(app.button.props['aria-busy'], true)
      assert.equal(app.tree.children[2].props.disabled, true)
      assert.equal(findNode(app.menu, node => node.props.children === 'Refreshing…').props.disabled, true)
      assert.equal(completed, false)
      if (succeeds) pendingStatus.resolve(response({ repo: true, dirty: true, modifiedFiles: 1, untrackedFiles: 0, conflicts: 0 }))
      else pendingStatus.reject(new Error('status unavailable'))
      await app.flush()
      assert.equal(app.button.props['aria-busy'], false)
      assert.equal(app.tree.children[2].props.disabled, false)
      assert.equal(completed, true)
      if (succeeds) assert.equal(app.button.props['data-dirty'], 'true')
      else assert.match(findNode(app.menu, node => node.props.className === 'gbp-menu-status').props.children, /failed/)
    } finally { app.unmount() }
  })
}

test('network or Git failure marks last successful branch stale and recovery clears it', async () => {
  for (const network of [true, false]) {
    let healthy = true
    const app = clientHarness(async url => {
      if (url === '/git/config') return bridge
      if (healthy) return branch('main')
      if (network) throw new Error('offline')
      return response({ repo: false, branch: null, reason: 'git-timeout' })
    })
    try {
      await app.flush()
      healthy = false
      await app.advance(3000)
      assert.equal(app.button.props['data-git-branch'], 'main')
      assert.equal(app.button.props['data-stale'], 'true')
      assert.match(app.button.props.title, /Last success/)
      healthy = true
      await app.advance(3000)
      assert.equal(app.button.props['data-stale'], 'false')
    } finally { app.unmount() }
  }
})

test('unknown initial state exposes explicit retry action', async () => {
  let healthy = false
  const app = clientHarness(async url => {
    if (url === '/git/config') return bridge
    if (!healthy) throw new Error('offline')
    return branch('recovered')
  })
  try {
    await app.flush()
    assert.equal(typeof app.tree.props.onRefresh, 'function')
    healthy = true
    refresh(app)
    await app.flush()
    assert.equal(app.button.props['data-git-branch'], 'recovered')
  } finally { app.unmount() }
})

test('worktree counts are fetched at thirty-second intervals, with manual bypass', async () => {
  let calls = 0
  const app = clientHarness(async url => url === '/git/config' ? bridge : branch('main'), {
    statusFetch: async () => { calls++; return response({ repo: true, dirty: true, modifiedFiles: 2, untrackedFiles: 1, conflicts: 0 }) },
  })
  try {
    await app.flush()
    assert.equal(app.button.props['data-dirty'], 'true')
    await app.advance(27000)
    assert.equal(calls, 1)
    await app.advance(3000)
    assert.equal(calls, 2)
    await app.openMenu()
    const summary = findNode(app.menu, node => node.props.className === 'gbp-menu-status')
    assert.match(summary.props.children, /Modified 2 · Untracked 1 · Conflicts 0/)
    refresh(app)
    await app.flush()
    assert.equal(calls, 3)
  } finally { app.unmount() }
})

test('failed status stays unknown and retries are throttled rather than every branch poll', async () => {
  let calls = 0
  const app = clientHarness(async url => url === '/git/config' ? bridge : branch('main'), {
    statusFetch: async () => { calls++; throw new Error('slow repository') },
  })
  try {
    await app.flush()
    await app.advance(27000)
    assert.equal(calls, 1)
    await app.openMenu()
    assert.match(findNode(app.menu, node => node.props.className === 'gbp-menu-status').props.children, /failed/)
    await app.advance(3000)
    assert.equal(calls, 2)
  } finally { app.unmount() }
})

test('menu offers explicit copy and current branch is pinned above matching branches', async () => {
  let copied
  const app = clientHarness(async url => {
    if (url === '/git/config') return bridge
    if (url === '/git/branches') return response({ ok: true, value: { branches: [{ name: 'feature/z' }, { name: 'main' }, { name: 'feature/a' }] } })
    return branch('main')
  }, { clipboard: { writeText: async text => { copied = text } } })
  try {
    await app.flush()
    await app.openMenu()
    const list = findNode(app.menu, node => node.type === 'ul')
    assert.equal(list.children[0][0].children[0].props.title, 'main')
    const input = findNode(app.menu, node => node.type === 'input')
    input.props.onChange({ target: { value: 'does-not-exist' } })
    await app.flush()
    assert.ok(findNode(app.menu, node => node.props.children === 'No matching branches'))
    assert.ok(findNode(app.menu, node => node.props['data-current'] === 'true'))
    findNode(app.menu, node => node.type === 'button' && node.props.children === 'Copy branch name').props.onClick()
    await app.flush()
    assert.equal(copied, 'main')
    assert.equal(app.menu, undefined)
  } finally { app.unmount() }
})

test('arrow navigation selects only switchable branches, Enter confirms from filter', async () => {
  const requests = []
  const app = clientHarness(async (url, options) => {
    if (url === '/git/config') return bridge
    if (url === '/git/branches') return response({ ok: true, value: { branches: [{ name: 'main' }, { name: 'one' }, { name: 'two' }] } })
    if (url === '/git/switch') { requests.push(JSON.parse(options.body).branch); return response({ ok: false, error: { message: 'blocked' } }) }
    return branch('main')
  })
  try {
    await app.flush()
    await app.openMenu()
    const event = key => ({ key, target: {}, preventDefault() {}, stopPropagation() {} })
    app.menu.props.onKeyDown(event('ArrowDown'))
    await app.flush()
    assert.equal(app.focused.at(-1), 'one')
    app.menu.props.onKeyDown(event('ArrowDown'))
    await app.flush()
    assert.equal(app.focused.at(-1), 'two')
    const input = findNode(app.menu, node => node.type === 'input')
    app.menu.props.onKeyDown({ ...event('Enter'), target: input.props.ref.current })
    await app.flush()
    assert.deepEqual(requests, ['two'])
  } finally { app.unmount() }
})

test('copy-only context menu remains available without the bridge', async () => {
  let copied
  const app = clientHarness(async url => {
    if (url === '/git/config') throw new Error('missing')
    return branch('main')
  }, { clipboard: { writeText: async text => { copied = text } } })
  try {
    await app.flush()
    app.button.props.onContextMenu({ preventDefault() {} })
    await app.flush()
    assert.ok(findNode(app.menu, node => node.props.children === 'Copy branch name'))
    assert.ok(findNode(app.menu, node => node.props.children === 'Refresh / Retry'))
    assert.equal(findNode(app.menu, node => node.type === 'input'), undefined)
    await app.advance(18000)
    assert.ok(app.menu, 'polls and repeated failed probes keep the action menu open')
    findNode(app.menu, node => node.props.children === 'Refresh / Retry').props.onClick()
    await app.flush()
    assert.ok(app.menu, 'manual refresh keeps the action menu open')
    findNode(app.menu, node => node.props.children === 'Copy branch name').props.onClick()
    await app.flush()
    assert.equal(copied, 'main')
    assert.equal(app.menu, undefined)
  } finally { app.unmount() }
})
