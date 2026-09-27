module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    // Shturval fork: Russian interface text (shturval/i18n/babel-plugin.cjs).
    plugins: ["./shturval/i18n/babel-plugin.cjs"],
  };
};
