/**
 * Group Session records by working directory, so the oldest Session of each
 * project can be identified from its own header.
 *
 *   node tests/sessions-by-cwd.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const sessionsRoot = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'sessions')
  : 'E:\\DSH-Data\\sessions'

const groups = new Map()

for (const workspaceDir of readdirSync(sessionsRoot)) {
  const workspacePath = join(sessionsRoot, workspaceDir)
  if (!statSync(workspacePath).isDirectory()) continue
  for (const sessionDir of readdirSync(workspacePath)) {
    const recordPath = join(workspacePath, sessionDir, 'session.v4.jsonl.zstd')
    let header
    try {
      const text = zstdDecompressSync(readFileSync(recordPath)).toString('utf8')
      header = JSON.parse(text.split('\n').find((line) => line.includes('"type":"session"')))
    } catch {
      continue
    }
    const group = groups.get(header.cwd) ?? []
    group.push({ id: header.id, createdAt: header.createdAt })
    groups.set(header.cwd, group)
  }
}

for (const [cwd, entries] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  entries.sort((a, b) => a.createdAt - b.createdAt)
  const first = entries[0]
  const oldest = new Date(first.createdAt).toISOString()
  console.log(`${cwd}  (${entries.length} sessions, oldest ${first.id} @ ${oldest})`)
}
