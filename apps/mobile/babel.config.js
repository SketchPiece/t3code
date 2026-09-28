module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    // Helm fork: Russian interface text (helm/i18n/babel-plugin.cjs).
    plugins: ["./helm/i18n/babel-plugin.cjs"],
  };
};
