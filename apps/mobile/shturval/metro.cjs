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

module.exports = function withShturvalOverrides(config) {
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
