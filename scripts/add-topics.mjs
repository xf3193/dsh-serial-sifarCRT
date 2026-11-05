#!/usr/bin/env node
/**
 * Add the GitHub topics the plugin market requires (notably `dsh-plugin`) to
 * the repository, through the GitHub REST API.
 *
 *   GH_TOKEN=ghp_xxx node scripts/add-topics.mjs OWNER/dsh-serial-sifarCRT
 *
 * A token needs the `repo` scope for a public repository. Without a token the
 * script prints the manual steps instead of failing silently.
 */
const topics = [
  'dsh-plugin',
  'deepseek-harness',
  'dsh',
  'serial',
  'serialport',
  'uart',
  'terminal',
  'windows',
  'securecrt',
]

const repo = process.argv[2]
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

if (!repo || repo.split('/').length !== 2) {
  console.error('usage: GH_TOKEN=<token> node scripts/add-topics.mjs OWNER/REPO')
  process.exit(2)
}

if (!token) {
  console.error('No GH_TOKEN / GITHUB_TOKEN in the environment.')
  console.error('')
  console.error('Add the topics manually instead:')
  console.error(`  1) open https://github.com/${repo}`)
  console.error('  2) About (gear icon) → Topics')
  console.error(`  3) add: ${topics.join(', ')}`)
  console.error('  4) Save changes')
  console.error('')
  console.error('A token needs the `repo` scope; create one at https://github.com/settings/tokens')
  process.exit(1)
}

const response = await fetch(`https://api.github.com/repos/${repo}/topics`, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-serial-sifarCRT-publisher',
  },
  body: JSON.stringify({ names: topics }),
})

if (!response.ok) {
  const body = await response.text()
  console.error(`GitHub API ${response.status}: ${body.slice(0, 500)}`)
  process.exit(1)
}

const data = await response.json()
console.log(`topics on ${repo}:`)
console.log('  ' + (data.names || []).join(', '))
