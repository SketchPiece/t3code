"use strict";

// Shturval fork: swaps selected upstream modules for the fork's versions at
// bundle time, so upstream files stay untouched. Keys are upstream paths
// relative to apps/mobile/src; values live in apps/mobile/shturval/overrides.
// A replacement must keep the upstream module's exports.

const path = require("node:path");

const SRC = path.resolve(__dirname, "../src");
const OVERRIDES = new Map(
  Object.entries({
    "components/CompactBrandTitle.tsx": "CompactBrandTitle.tsx",
    "components/BrandMark.tsx": "BrandMark.tsx",
    "components/T3Wordmark.tsx": "T3Wordmark.tsx",
    "lib/useFontFamily.ts": "useFontFamily.ts",
    "features/home/home-list-filter-menu.ts": "home-list-filter-menu.ts",
  }).map(([upstream, fork]) => [path.join(SRC, upstream), path.join(__dirname, "overrides", fork)]),
);

// Metro caches transforms by source, so a dictionary edit would not reach
// files that did not change; the cache version follows the translation inputs.
function translationCacheKey() {
  const hash = require("node:crypto").createHash("sha1");
  for (const file of ["ru.json", "rules.cjs", "babel-plugin.cjs"]) {
    hash.update(require("node:fs").readFileSync(path.join(__dirname, "i18n", file)));
  }
  return hash.digest("hex").slice(0, 12);
}

module.exports = function withShturvalOverrides(config) {
  config.cacheVersion = `${config.cacheVersion ?? ""}shturval-${translationCacheKey()}`;
  const previous = config.resolver?.resolveRequest;
  config.resolver = {
    ...config.resolver,
    resolveRequest(context, moduleName, platform) {
      const resolved = previous
        ? previous(context, moduleName, platform)
        : context.resolveRequest(context, moduleName, platform);
      if (resolved.type !== "sourceFile") return resolved;
      const replacement = OVERRIDES.get(resolved.filePath);
      return replacement ? { type: "sourceFile", filePath: replacement } : resolved;
    },
  };
  return config;
};
