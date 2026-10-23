/**
 * Discover the Client plugin-bundle source format: which specifiers a bundle
 * may require, and how a shipped entry exports its plugin face.
 *
 *   node tests/loader-contract.mjs
 */
import { readFileSync } from 'node:fs'

const base = 'E:/dsh/resources/app/dsh/node_modules/@deepseek-ai'

/** Report the require specifiers and the export face a shipped bundle uses. */
const inspect = (name) => {
  const file = `${base}/${name}/lib/client.js`
  const text = readFileSync(file, 'utf8')
  const firstLines = text.split('\n').slice(0, 8).join('\n')
  const requires = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
  const tail = text.slice(-800)
  return {
    name,
    head: firstLines,
    requires: [...new Set(requires)],
    tail,
  }
}

for (const name of ['dsh-client-ui-goal', 'dsh-client-ui-plan']) {
  const result = inspect(name)
  console.log(`=== ${result.name}`)
  console.log(result.head)
  console.log('requires:', result.requires.join(' | '))
  console.log('tail:', result.tail.replace(/\s+/g, ' ').slice(-300))
  console.log()
}

// Which of the require targets resolve inside the shipped tree?
import { existsSync } from 'node:fs'
for (const name of ['dsh-client-ui-primitives', 'dsh-client-ui-slots', 'dsh-client-locale']) {
  console.log(`${name} shipped:`, existsSync(`${base}/${name}`))
}
