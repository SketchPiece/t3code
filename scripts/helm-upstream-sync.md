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
- Neither: reply with one short line and settle the thread (step 5). Nothing
  else.

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
- upstream moved or renamed code a Helm hook lives in: move the hook along;
- anything in `apps/mobile`: take upstream's side. The fork's mobile app is no
  longer developed; Helm Mobile is a separate project.

Stop and ask when:

- upstream rewrote logic that a Helm change also rewrote, and both sides
  can't simply be kept;
- upstream removed or replaced something Helm builds on (voice
  input, the theme);
- you're unsure what the user would want.

To ask: leave the worktree mid-merge and reply in the thread with, for each
hard conflict, the file, what upstream changed, what Helm changed, 2-3 options
and the one you recommend. The user answers in the thread; then continue here.

Background on what Helm changes and why: the `helm-fork` memory.

## 3. Check

In the sync worktree, after the merge is committed:

```sh
T3CODE_PROJECT_ROOT=~/Documents/Projects/t3code node scripts/setup-worktree.ts
PATH="$PWD/node_modules/.bin:$PATH"
vp run --filter t3 --filter @t3tools/web --filter @t3tools/desktop typecheck
vp test run apps/server/src/helm packages/client-runtime/src/voice-input
```

Mobile isn't checked (see above). A typecheck or test failure caused by the merge is a conflict too:
fix it if it's easy, ask if it's hard.

### Helm's features still work with upstream's

Passing typecheck and the smoke test is not enough: on 2026-10-22 a merge
silently dropped the effect in `ChatView.tsx` that tells Helm Mobile which
thread is open. Its imports stayed, so everything compiled and launched, and
the phone's remote just disappeared. Every merge must show that Helm's own
changes came through and still fit what upstream changed.

1. **Nothing of Helm's was lost.** With the merge committed:

   ```sh
   node scripts/helm-fork-check.ts
   ```

   It lists each line Helm had added on top of the previous upstream that is
   nowhere in the merged tree. Go through every line under "Missing from
   code" and decide:
   - reworded or adapted on purpose while resolving (an import trimmed, text
     reflowed, a hook moved into upstream's new code): fine, say so in the
     report;
   - dropped by mistake: restore it (look at `git show HEAD^1:<file>`), then
     rerun the check and step 3;
   - upstream removed the code it lived in and there's no obvious new home:
     a hard conflict, ask.

   "Missing from tests" is usually upstream pruning its own tests; glance at
   it and restore only tests that cover Helm's behaviour.

2. **Helm's hooks fit upstream's changes.** Files both sides touched:

   ```sh
   base=$(git merge-base HEAD^1 HEAD^2)
   comm -12 <(git diff --name-only "$base" HEAD^1 | sort) <(git diff --name-only "$base" HEAD^2 | sort)
   ```

   For each file outside `apps/mobile`, read upstream's change
   (`git diff "$base" HEAD^2 -- <file>`) next to Helm's hook in the merged
   file. The hook has to still run where it did: not left behind in code
   upstream no longer calls, not bypassed by a new path upstream added (a new
   route, component or RPC that does the same job without Helm's hook). Fix
   easy cases; ask about hard ones.

3. **What Helm Mobile depends on is intact.** The phone app (separate project
   `~/Documents/Projects/helm-mobile`) relies on these; if the merge touched
   any of them, check by reading the merged code that it still does its job:
   - open thread / draft and composer state in the activity report
     (`retainOpenThreadScope` and `retainOpenDraftThreadScope` called from
     `apps/web/src/components/ChatView.tsx`, `lib/backgroundActivityReporter.ts`)
     and the `subscribeBackgroundPolicy` stream with `hostPower`: the remote;
   - the Bonjour announcement `_helm._tcp` with `environmentId` in its TXT
     record (`apps/server/src/helm/nearbyAdvertiser.ts`): finding the Mac on the
     local network;
   - `apps/web/src/helm/` (draft sync, remote commands, remote composer and
     dictation, tailnet pairing) and the hooks that mount them in
     `routes/__root.tsx`, `ChatComposer.tsx`;
   - `apps/server/src/helm/` (push, screen remote and the rest) and its hooks
     in `ws.ts`, `server.ts`, `auth/RpcAuthorization.ts`, `httpCors.ts`.

   Search the merged tree for each entry point (`grep -rn`): a Helm function
   that is still exported but no longer called anywhere is exactly the
   failure this section exists for.

If any of this turns up a problem you can't fix with confidence, don't
release: report it (step 4's reply) and ask, and don't settle the thread.

## 4. Release

```sh
scripts/helm-release.sh
```

It installs exactly what `pnpm-lock.yaml` pins first
(`scripts/helm-check-deps.sh`, a frozen `vp i`), builds the signed
update zip (no DMG: installed apps update from the zip), launches the built update twice in a throwaway HOME (fresh profile, then
a pruned copy of the real Helm data and window state) with
`scripts/helm-smoke-mac.sh`, which also walks the restored screen, a new
draft, a thread and settings looking for a crash screen or React error
(`scripts/helm-smoke-renderer.ts`), and only then pushes HEAD to `origin/helm` and
publishes the GitHub release that installed Helm apps update from. Installed
apps restart into a new release on their own once they are idle, so a build
that fails the launch check must never ship: if it fails, nothing is
published. Report the failing run and its log path (it stays in
`/tmp/helm-smoke.*`) and ask; don't retry blindly or skip the check.

The upload is slow on this connection (about an hour at worst), so run the
script with a long background timeout. The upload itself runs detached and
survives a Helm restart or a killed script: if the run is cut off, run the
script again in the same worktree; it finds the draft for HEAD, reuses the
build and waits for or resumes the upload. Then move the main checkout's
`helm` branch to the released commit:

```sh
git -C ~/Documents/Projects/t3code merge --ff-only <released sha>
```

If that fails (someone committed to `helm` meanwhile, or the merge touches
files with uncommitted edits there), don't force it: tell the user.

Reply with one short message: the upstream tag, the Helm version, the
release link, and anything you fixed or translated along the way. Always
add one line on Helm's features: how many lines `helm-fork-check.ts`
reported and what you did with each (restored, adapted on purpose), and any
hook you moved to fit upstream's changes. If upstream added something that
overlaps a Helm feature (does the same job differently, or makes a Helm
change unnecessary), mention it so the user can decide; don't remove Helm's
side on your own.

## 5. Settle the thread

When the run needed nothing from the user (nothing new, or released with
every conflict resolved and every check passing), call `t3_thread_organize`
with `action: "settle"` and no `threadId` right before the final reply. Helm
settles the thread when the turn ends, so the run doesn't wait in the inbox.
Don't settle when you are asking about a hard conflict, a check failed, a
Helm feature may be broken or lost, the release or the `helm` fast-forward
failed, or anything else needs the user.
