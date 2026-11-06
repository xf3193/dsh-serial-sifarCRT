# Publishing dsh-serial-sifarCRT (GitHub + npm + dsh-market)

This is the checklist for turning this directory into a public plugin in
**dsh-market**, the community market that ships as `dshmarket` and is driven by
the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
registry.

Two names matter and they differ:

| Thing | Value | Why |
|---|---|---|
| Repository / market name | `dsh-serial-sifarCRT` | GitHub repo and the `owner/repo` line in the market |
| npm package name | `dsh-serial-sifarcrt` | npm rejects uppercase in new package names; the client bundle id and the install command use this |

The DSH plugin display title is `dsh-serial-sifarCRT` (`locale/*.json`).

---

## 0. Prerequisites

- GitHub account (repo must be **public** and at least **1 day old** before the
  registry PR is accepted).
- npm account if you want npm installs (strongly recommended 鈥?the market
  prefers repo-verified npm packages, and installs are fast and update-checkable).
- This directory already installs and runs locally; no build step exists.

## 1. Put your GitHub owner into the files

```powershell
node scripts/set-owner.mjs <your-github-user-or-org>
```

It rewrites the `OWNER` placeholder in `package.json`, `README.md`, this file and
`market/awesome-plugin-entry.yml`. Confirm:

```powershell
git diff
```

## 2. Verify the package locally (no publishing yet)

```powershell
node --check lib/index.js
node --check lib/client.js
npm pack
```

`npm pack` must print a tarball whose `files` are exactly what the table in
[README](./README.md) describes (`lib/`, `locale/`, `assets/`, `cordis.patch.yml`,
`icon.svg`, `README.md`, `LICENSE`). Install that tarball once on a machine with
DSH to be sure:

```powershell
dsh plugin --profile web add .\dsh-serial-sifarcrt-1.0.1.tgz
```

Refresh the DSH page, open the right sidebar 鈫?`sifarCRT`, connect a COM port and
send a command. Remove it again for a clean state if you like:
`dsh plugin --profile web remove dsh-serial-sifarcrt`.

## 3. Create the GitHub repository and push

```powershell
git init
git add -A
git commit -m "dsh-serial-sifarCRT 1.0.1"
git branch -M main
git remote add origin https://github.com/xf3193/dsh-serial-sifarCRT.git
git push -u origin main
```

Make sure `package.json` contains:

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // required for `dsh plugin add`
  "client": { "platform": "web", ... }            // browser UI
}
```

and `cordis.patch.yml` exists at the repo root (it does).

## 4. Add the GitHub topics 鈥?**this is the required 鈥淭opic鈥?*

The registry requires the **`dsh-plugin`** topic on the repository. Add it (and
the recommended discovery topics) **before** opening the market PR:

```powershell
# with GitHub CLI (install: winget install GitHub.cli; gh auth login)
gh repo edit xf3193/dsh-serial-sifarCRT --add-topic dsh-plugin,deepseek-harness,dsh,serial,serialport,uart,terminal,windows,securecrt
```

Without `gh`, use the GitHub REST API (token needs `repo` scope):

```powershell
$token = Read-Host -MaskInput "GitHub token"
$body = '{"names":["dsh-plugin","deepseek-harness","dsh","serial","serialport","uart","terminal","windows","securecrt"]}'
Invoke-RestMethod -Method Put -Uri https://api.github.com/repos/xf3193/dsh-serial-sifarCRT/topics `
  -Headers @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json" } `
  -Body $body -ContentType 'application/json'
```

Or in the browser: repo page 鈫?**About** (gear) 鈫?**Topics** 鈫?type
`dsh-plugin`, Enter, then add the others 鈫?**Save changes**.

`node scripts/add-topics.mjs xf3193/dsh-serial-sifarCRT` does the API call for you
when `GH_TOKEN` (or `GITHUB_TOKEN`) is set.

## 5. Publish to npm (recommended)

Your machine's `.npmrc` points at `registry.npmmirror.com` (a read-only mirror),
so log in to and publish to the official registry explicitly:

```powershell
npm login --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/ --access public
```

Verify:

```powershell
npm view dsh-serial-sifarcrt version --registry=https://registry.npmjs.org/
dsh plugin --profile web add dsh-serial-sifarcrt
```

Notes:

- `publishConfig` already pins `registry.npmjs.org` and `access: public`.
- Do not commit tokens. For CI publishing, add an npm automation token as the
  repository secret `NPM_TOKEN`, then run the **Publish to npm** workflow manually
  from the Actions tab (`.github/workflows/publish.yml` is `workflow_dispatch`).
  Tag pushes no longer trigger it, so a missing secret cannot turn a release red.
- If the name is taken, publish under a scope (`@your-name/dsh-serial-sifarcrt`),
  then change `name`, the client bundle id (`window.__ModuleLoader__.load({id})`),
  `cordis.patch.yml`, and the install commands to match.

## 6. Cut a GitHub release (optional, useful fallback)

```powershell
git tag v1.0.1
git push origin v1.0.1
```

Create a release from that tag (notes + the packed tarball). The market tries
npm first, then author-supplied release tarballs, then the repository source, so
a release makes non-npm installs faster. No build step is needed.

## 7. Submit to the market registry (one YAML file, one PR)

The market app reads the curated **awesome-dsh-plugin** registry, not its own
repo. Add exactly one file there:

1. Fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.
2. Copy [`market/awesome-plugin-entry.yml`](./market/awesome-plugin-entry.yml) to
   `data/plugins/OWNER__dsh-serial-sifarCRT.yml` in the fork (filename = owner +
   two underscores + repo name).
3. Commit and open a PR titled e.g. `Add dsh-serial-sifarCRT (Windows serial
   debug console)`.
4. In the PR description, state what it does in one or two sentences and confirm
   `dsh.bundle` install works from a clean profile.

Repo requirements checked by their CI/review: public repo, 鈮? day old, real
working code, `dsh-plugin` topic set, description accurate, right category
(`tools`). Do **not** edit the generated READMEs in that repo.

After merge, CI refreshes `plugins.json` (usually within a day) and the entry
appears in dsh-market (Discover) and in the format-1 index at
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`.

## 8. Updates

1. Bump `version` in `package.json`.
2. `npm publish --registry=https://registry.npmjs.org/ --access public`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` (optional release).
4. The market detects the new npm version and offers **Update**; the catalog
   keeps the same entry 鈥?no second PR needed.

## 9. Remove / rollback

- `dsh plugin --profile web remove dsh-serial-sifarcrt`
- npm: `npm unpublish dsh-serial-sifarcrt@1.0.1` only within 72h and only if
  nothing depends on it; prefer `npm deprecate` afterwards.
- Registry: the maintainers remove entries whose repo disappears or goes dormant.

---

## Quick checklist

- [ ] `node scripts/set-owner.mjs <owner>`
- [ ] `npm pack` contents correct; local DSH install verified
- [ ] public GitHub repo pushed (repo name `dsh-serial-sifarCRT`)
- [ ] GitHub topic **`dsh-plugin`** added (plus discovery topics)
- [ ] `npm publish` done; `npm view` confirms the version
- [ ] registry YAML PR opened in `awesome-dsh-plugin` (category `tools`)
- [ ] tarball/release available for offline installs
- [ ] README accurate and free of marketing superlatives

