# Helm upstream sync

Procedure the daily Helm scheduled task follows: merge the newest upstream T3
Code nightly into `helm`, and when the merge is easy, ship it, together with
Helm's own commits since the last release, as a Helm update with
`scripts/helm-release.sh`. Installed Helm apps then offer the update.

Main checkout: `~/Documents/Projects/t3code` (branch `helm`, remotes
`origin` = SketchPiece/t3code, `upstream` = pingdotgg/t3code). The user and
other threads work there, so the merge and the build happen in the sync
worktree `~/Documents/Projects/t3code-helm-sync` (detached HEAD).

## 1. Is there anything new?

```sh
git -C ~/Documents/Projects/t3code fetch upstream --tags --prune
tag=$(git -C ~/Documents/Projects/t3code tag -l 'v*-nightly.*' --sort=-creatordate | head -1)
git -C ~/Documents/Projects/t3code merge-base --is-ancestor "$tag" helm && echo "up to date"
```

Helm's own work ships the same way. Find what the last release was built from:

```sh
git -C ~/Documents/Projects/t3code fetch origin --tags
last=$(gh release list -R SketchPiece/t3code -L 1 --json tagName -q '.[0].tagName')
git -C ~/Documents/Projects/t3code log --oneline "$last"..helm
```

- New upstream tag: go on with step 2.
- Upstream up to date, but `helm` has commits since `$last`: skip the merge,
  run step 3 in the main checkout (no worktree needed), then step 4.
- Neither: stop and reply with one short line. Nothing else.

## 2. Merge in the sync worktree

```sh
cd ~/Documents/Projects/t3code
[ -d ../t3code-helm-sync ] || git worktree add --detach ../t3code-helm-sync helm
cd ../t3code-helm-sync
git checkout --detach helm && git reset --hard helm
git merge --no-ff "$tag" -m "Merge upstream $tag into helm"
```

If a merge from an earlier run is still waiting for the user's answer, carry
on with that one instead of starting over.

### Easy or hard?

Fix these yourself:

- lockfile (`pnpm-lock.yaml`): take upstream's, then `vp i` regenerates it;
- version fields, generated files, changelogs;
- a Helm one-line hook (`// Helm:` comment, Helm naming, Helm port 3783,
  palette import) sitting next to an upstream edit: keep both;
- upstream moved or renamed code a Helm hook lives in: move the hook along.

Stop and ask when:

- upstream rewrote logic that a Helm change also rewrote, and both sides
  can't simply be kept;
- upstream removed or replaced something Helm builds on (the mobile
  Tailscale module, push via the Volna core, voice input, the theme);
- you're unsure what the user would want.

To ask: leave the worktree mid-merge and reply in the thread with, for each
hard conflict, the file, what upstream changed, what Helm changed, 2-3 options
and the one you recommend. The user answers in the thread; then continue here.

Background on what Helm changes and why: the `helm-fork` memory and
`apps/mobile/helm/`.

## 3. Check

In the sync worktree, after the merge is committed:

```sh
T3CODE_PROJECT_ROOT=~/Documents/Projects/t3code node scripts/setup-worktree.ts
PATH="$PWD/node_modules/.bin:$PATH"
vp run --filter t3 --filter @t3tools/web --filter @t3tools/desktop --filter @t3tools/mobile typecheck
vp test run apps/server/src/helm apps/mobile/helm
node apps/mobile/helm/i18n/scan.cjs
```

New untranslated strings from the scan: add Russian entries to
`apps/mobile/helm/i18n/ru.json` (short, ты-form, display text only) and
commit. A typecheck or test failure caused by the merge is a conflict too:
fix it if it's easy, ask if it's hard.

## 4. Release

```sh
scripts/helm-release.sh
```

It builds the signed DMG, pushes HEAD to `origin/helm`, and publishes the
GitHub release that installed Helm apps update from. Then move the main
checkout's `helm` branch to the released commit:

```sh
git -C ~/Documents/Projects/t3code merge --ff-only <released sha>
```

If that fails (someone committed to `helm` meanwhile, or the merge touches
files with uncommitted edits there), don't force it: tell the user.

Reply with one short message: the upstream tag, the Helm version, the
release link, and anything you fixed or translated along the way.
