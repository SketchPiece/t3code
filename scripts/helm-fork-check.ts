// Helm: after an upstream merge, lists Helm's own lines that the merge lost.
//
// Helm's changes are the lines `helm` adds on top of the upstream nightly it was last
// merged with. Each of them should still be somewhere in the merged tree; one that isn't
// was either adapted on purpose while resolving a conflict or dropped by mistake (on
// 2026-10-22 a merge dropped the effect that reports the open thread to Helm Mobile;
// imports stayed, typecheck and smoke passed, and the phone's remote just vanished).
//
// Usage, in the sync worktree with the merge committed:
//   node scripts/helm-fork-check.ts            # HEAD is the merge: HEAD^1 is helm, HEAD^2 upstream
//   node scripts/helm-fork-check.ts <before> <after> <upstream>
// Exit code 1 when something is missing.

import { execFileSync } from "node:child_process";

const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });

const [before = "HEAD^1", after = "HEAD", upstream = "HEAD^2"] = process.argv.slice(2);
const base = git("merge-base", before, upstream).trim();

// Paths where upstream's side is taken on purpose (see helm-upstream-sync.md).
const ignored = [":!pnpm-lock.yaml", ":!apps/mobile", ":!**/CHANGELOG.md", ":!**/*.snap"];

/** Lines worth checking: not blank, not bare punctuation or a lone keyword. */
const meaningful = (line: string) => line.length >= 6 && /[A-Za-z0-9]{3}/.test(line);

/** Helm's added lines per file, from the diff base..before. */
function helmLines(): Map<string, string[]> {
  const diff = git("diff", "-U0", "--no-color", "-M", base, before, "--", ".", ...ignored);
  const byFile = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
      continue;
    }
    if (file === null || !line.startsWith("+") || line.startsWith("+++")) continue;
    const text = line.slice(1).trim();
    if (!meaningful(text)) continue;
    const list = byFile.get(file) ?? [];
    list.push(text);
    byFile.set(file, list);
  }
  return byFile;
}

function trimmedLines(rev: string, file: string): Set<string> | null {
  try {
    return new Set(
      git("show", `${rev}:${file}`)
        .split("\n")
        .map((l) => l.trim()),
    );
  } catch {
    return null;
  }
}

/** The line exists anywhere in `after` (code moved to another file along with upstream). */
function foundElsewhere(text: string): boolean {
  try {
    git("grep", "-q", "-F", "-e", text, after, "--", ".", ...ignored);
    return true;
  } catch {
    return false;
  }
}

const missing = new Map<string, string[]>();
let checked = 0;
for (const [file, lines] of helmLines()) {
  const present = trimmedLines(after, file);
  for (const text of lines) {
    checked++;
    if (present?.has(text)) continue;
    if (foundElsewhere(text)) continue;
    const list = missing.get(present === null ? `${file} (file is gone)` : file) ?? [];
    list.push(text);
    missing.set(present === null ? `${file} (file is gone)` : file, list);
  }
}

// Upstream prunes and rewrites its tests often; a Helm line lost from code matters far more.
const isTest = (file: string) => /\.(test|spec)\.[cm]?[jt]sx?\b/.test(file);
const sections = [
  ["Missing from code:", [...missing].filter(([file]) => !isTest(file))],
  [
    "Missing from tests (upstream may have pruned or rewritten them):",
    [...missing].filter(([file]) => isTest(file)),
  ],
] as const;

console.log(
  `Helm lines since upstream ${base.slice(0, 10)}: ${checked} checked in ${after}, ` +
    `${[...missing.values()].reduce((n, l) => n + l.length, 0)} missing.`,
);
for (const [title, entries] of sections) {
  if (entries.length === 0) continue;
  console.log(`\n${title}`);
  for (const [file, lines] of entries) {
    console.log(`\n${file}`);
    for (const text of lines) console.log(`  - ${text}`);
  }
}
process.exit(missing.size > 0 ? 1 : 0);
