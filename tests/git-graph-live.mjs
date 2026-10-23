/**
 * Probe the live git-graph routes the pill borrows. Needs a running DSH Web UI
 * that has @linxin666/dsh-client-ui-git-graph installed.
 *
 *   node tests/git-graph-live.mjs [http://127.0.0.1:PORT] [directory]
 *
 * Unauthenticated calls answer 401/403 by design; this script reports the exact
 * status so a missing route (404) is never confused with a refused one.
 */
const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:51589'
const directory = process.argv[3] ?? process.cwd()

const probe = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  return { status: response.status, body: text.slice(0, 160) }
}

for (const [path, payload] of [
  ['/git/config', {}],
  ['/git/branches', { path: directory }],
]) {
  const result = await probe(path, payload)
  // 404 means the route is absent (plugin not composing); anything else means it
  // is mounted and the request was handled, whatever the auth outcome.
  const verdict = result.status === 404 ? 'ABSENT' : 'MOUNTED'
  console.log(`${verdict.padEnd(8)} ${path} -> ${result.status} ${result.body.replace(/\s+/g, ' ')}`)
}
