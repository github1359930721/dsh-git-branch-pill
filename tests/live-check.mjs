/**
 * Verify the live page actually picked up the plugin: the composed Client graph
 * must list the entry and the bundle must be servable at the URL the page
 * boots with.
 *
 *   node tests/live-check.mjs [http://127.0.0.1:55071]
 */
const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:55071'
const entryId = 'dsh-git-branch-pill'

const index = await fetch(`${base}/`, { redirect: 'manual' })
const html = index.status === 200 ? await index.text() : ''
console.log(`GET / -> ${index.status}`)

const graphMatch = html.match(/__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})<\/script>/)
let entry
if (graphMatch !== null) {
  try {
    const boot = JSON.parse(graphMatch[1])
    const entries = boot?.graph?.entries ?? boot?.entries ?? []
    entry = entries.find((row) => row.id === entryId)
    console.log('boot graph entries:', entries.length)
  } catch (error) {
    console.log('boot payload parse failed:', error.message)
  }
} else {
  console.log('boot payload not present in HTML (auth gate or shell change)')
}

console.log('entry in boot graph:', entry === undefined ? 'NO' : JSON.stringify({ id: entry.id, rev: entry.rev }))

if (entry !== undefined) {
  const probe = await fetch(`${base}/plugins/${entryId}/client.js`)
  console.log(`GET /plugins/${entryId}/client.js -> ${probe.status}`)
}
