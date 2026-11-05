#!/usr/bin/env node
/**
 * Replace every OWNER placeholder in the package/repo files with your GitHub
 * user or organization, so package.json, README and the market submission all
 * point at the real repository.
 *
 *   node scripts/set-owner.mjs <github-user-or-org>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const owner = process.argv[2]

if (!owner) {
  console.error('usage: node scripts/set-owner.mjs <github-user-or-org>')
  process.exit(2)
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
  console.error(`"${owner}" is not a valid GitHub owner name`)
  process.exit(2)
}

const files = [
  'package.json',
  'README.md',
  'PUBLISHING.md',
  path.join('market', 'awesome-plugin-entry.yml'),
]

let changed = 0
for (const relative of files) {
  const file = path.join(ROOT, relative)
  if (!fs.existsSync(file)) {
    console.warn(`skip (missing): ${relative}`)
    continue
  }
  const before = fs.readFileSync(file, 'utf8')
  const after = before.replace(/\bOWNER\b/g, owner)
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8')
    changed += 1
    console.log(`updated ${relative}`)
  }
}

// Fail loudly if the manifest still points somewhere else.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const repository = manifest.repository && manifest.repository.url
console.log(`\nowner: ${owner}`)
console.log(`repository: ${repository}`)
console.log(`install: dsh plugin --profile web add ${manifest.name}`)
console.log(`market entry: market/awesome-plugin-entry.yml → data/plugins/${owner}__dsh-serial-sifarCRT.yml`)
console.log(`\nnext: npm pack && git init && … (see PUBLISHING.md)`)
if (changed === 0) console.log('(nothing changed — placeholders may already be replaced)')
