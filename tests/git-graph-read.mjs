/**
 * Read the live git-graph branch list through the same protocol the pill uses.
 *
 *   node tests/git-graph-read.mjs [base-url] [directory]
 */
const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:51589'
const directory = process.argv[3] ?? process.cwd()

const post = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (body?.ok !== true) throw new Error(body?.error?.message ?? `status ${response.status}`)
  return body.value
}

const config = await post('/git/config', {})
console.log('worktreesHome:', config.worktreesHome)

const view = await post('/git/branches', { path: directory })
console.log('root      :', view.root)
console.log('current   :', view.branch)
console.log('dirty     :', view.dirtyFiles, '| untracked:', view.untrackedFiles, '| conflicts:', view.conflicts)
console.log('branches  :', view.branches.map((row) => `${row.current ? '*' : ' '}${row.name}`).join('  '))
