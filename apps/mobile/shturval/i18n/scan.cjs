#!/usr/bin/env node
"use strict";

// Shturval fork: lists interface strings that ru.json does not translate yet.
// Run after merging upstream: node apps/mobile/shturval/i18n/scan.cjs [--all]
// Prints JSON of { "English key": "first/file.tsx" } for untranslated strings
// (--all includes translated ones too).

const fs = require("node:fs");
const path = require("node:path");
const { isTranslatableFile, isInterfaceTextPath, templateKey } = require("./rules.cjs");

const presetPath = require.resolve("babel-preset-expo", {
  paths: [path.resolve(__dirname, "../..")],
});
const babelPaths = { paths: [presetPath] };
const parser = require(require.resolve("@babel/parser", babelPaths));
const traverse = require(require.resolve("@babel/traverse", babelPaths)).default;

const MOBILE = path.resolve(__dirname, "../..");
const WORKSPACE = path.resolve(MOBILE, "../..");
const ROOTS = [
  path.join(MOBILE, "src"),
  path.join(MOBILE, "shturval", "overrides"),
  path.join(WORKSPACE, "packages", "client-runtime", "src"),
];
const dictionary = JSON.parse(fs.readFileSync(path.join(__dirname, "ru.json"), "utf8"));
const includeAll = process.argv.includes("--all");

// Heuristic for text a person reads: has letters, and a space or a capital.
const looksLikeText = (s) =>
  (/[A-Za-z]/.test(s) &&
    (/\s/.test(s.trim()) || /^[A-Z]/.test(s)) &&
    !/^[A-Z][A-Za-z0-9]+$/.test(s)) ||
  /^[A-Z][a-z]+$/.test(s);

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield full;
  }
}

const found = new Map();
const note = (key, file) => {
  const trimmed = key.trim().replace(/\s+/g, " ");
  if (!trimmed || !looksLikeText(trimmed)) return;
  if (!includeAll && Object.hasOwn(dictionary, trimmed)) return;
  if (!found.has(trimmed)) found.set(trimmed, path.relative(WORKSPACE, file));
};

for (const root of ROOTS) {
  for (const file of files(root)) {
    if (!isTranslatableFile(file)) continue;
    const ast = parser.parse(fs.readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
    traverse(ast, {
      JSXText(p) {
        note(p.node.value, file);
      },
      StringLiteral(p) {
        if (isInterfaceTextPath(p, file)) note(p.node.value, file);
      },
      TemplateLiteral(p) {
        if (p.node.expressions.length > 0 && isInterfaceTextPath(p, file))
          note(templateKey(p.node), file);
      },
    });
  }
}

process.stdout.write(`${JSON.stringify(Object.fromEntries(found), null, 1)}\n`);
