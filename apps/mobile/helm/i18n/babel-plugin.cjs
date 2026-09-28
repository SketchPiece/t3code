"use strict";

// Helm fork: shows the mobile app in Russian without editing upstream
// files. At bundle time, interface strings found in ru.json are swapped for
// their translation; everything else stays English. rules.cjs decides which
// literals are interface text.
//
// Dictionary values may reference template expressions by index — {0} — and
// pick a Russian plural form from one of them — {0|файл|файла|файлов}.

const path = require("node:path");
const { isTranslatableFile, isInterfaceTextPath, templateKey } = require("./rules.cjs");

const WORKSPACE = path.resolve(__dirname, "../../../..");
const DICTIONARY_PATH = path.join(__dirname, "ru.json");
const PLURAL_MODULE = path.join(__dirname, "plural.ts");
const TOKEN = /\{(\d+)(?:\|([^|}]*)\|([^|}]*)\|([^|}]*))?\}/g;
const HAS_TOKEN = /\{\d+[|}]/;

// Keys are stored trimmed with single spaces; the source's own edge
// whitespace (" and ", "Tap ") is put back around the translation.
const normalize = (text) => text.trim().replace(/\s+/g, " ");
const edges = (text) => ({ lead: text.match(/^\s*/)[0], trail: text.match(/\s*$/)[0] });

function loadDictionary() {
  delete require.cache[DICTIONARY_PATH];
  return require(DICTIONARY_PATH);
}

module.exports = function helmRussian({ types: t }, options = {}) {
  // Tests pass their own dictionary; builds read ru.json.
  const dictionary = options.dictionary ?? loadDictionary();
  // "$exclude": { "English key": ["path/from/repo/root.ts"] } keeps a key English
  // in files where the same words are data or go to the agent.
  const excludes = dictionary.$exclude ?? {};
  const lookup = (key, state) => {
    if (key === "$exclude" || !Object.hasOwn(dictionary, key)) return undefined;
    if (excludes[key]?.includes(state.relativeFilename)) return undefined;
    return dictionary[key];
  };

  function buildTemplate(value, expressions, state) {
    const quasis = [];
    const parts = [];
    let text = "";
    let last = 0;
    for (const match of value.matchAll(TOKEN)) {
      text += value.slice(last, match.index);
      last = match.index + match[0].length;
      const expression = expressions[Number(match[1])];
      if (!expression) return undefined;
      quasis.push(t.templateElement({ raw: text.replace(/[`\\$]/g, "\\$&"), cooked: text }));
      text = "";
      if (match[2] === undefined) {
        parts.push(t.cloneNode(expression, true));
      } else if (!state.allowImports) {
        return undefined;
      } else {
        state.needsPlural = true;
        parts.push(
          t.callExpression(t.identifier("__helmRuPlural"), [
            t.cloneNode(expression, true),
            t.stringLiteral(match[2]),
            t.stringLiteral(match[3]),
            t.stringLiteral(match[4]),
          ]),
        );
      }
    }
    text += value.slice(last);
    quasis.push(t.templateElement({ raw: text.replace(/[`\\$]/g, "\\$&"), cooked: text }, true));
    return t.templateLiteral(quasis, parts);
  }

  return {
    name: "helm-russian",
    visitor: {
      Program: {
        enter(_path, state) {
          state.enabled = isTranslatableFile(state.filename);
          state.relativeFilename = state.filename ? path.relative(WORKSPACE, state.filename) : "";
          state.needsPlural = false;
          // Widget layouts are serialized into the widget extension on their
          // own, so they cannot import the plural helper.
          state.allowImports = !/[\\/]src[\\/]widgets[\\/]/.test(state.filename ?? "");
        },
        exit(programPath, state) {
          if (!state.needsPlural) return;
          programPath.unshiftContainer(
            "body",
            t.importDeclaration(
              [t.importSpecifier(t.identifier("__helmRuPlural"), t.identifier("ruPlural"))],
              t.stringLiteral(PLURAL_MODULE),
            ),
          );
        },
      },
      JSXText(textPath, state) {
        if (!state.enabled) return;
        const raw = textPath.node.value;
        const value = lookup(normalize(raw), state);
        if (typeof value !== "string" || HAS_TOKEN.test(value)) return;
        const { lead, trail } = edges(raw);
        textPath.replaceWith(t.jsxText(lead + value + trail));
        textPath.skip();
      },
      StringLiteral(literalPath, state) {
        if (!state.enabled) return;
        const raw = literalPath.node.value;
        const value = lookup(normalize(raw), state);
        if (typeof value !== "string") return;
        if (!isInterfaceTextPath(literalPath, state.filename)) return;
        literalPath.replaceWith(t.stringLiteral(edges(raw).lead + value + edges(raw).trail));
        literalPath.skip();
      },
      TemplateLiteral(templatePath, state) {
        if (!state.enabled) return;
        const key = templateKey(templatePath.node);
        const value = lookup(normalize(key), state);
        if (typeof value !== "string") return;
        if (!isInterfaceTextPath(templatePath, state.filename)) return;
        const { lead, trail } = edges(key);
        const replacement = buildTemplate(
          lead + value + trail,
          templatePath.node.expressions,
          state,
        );
        if (!replacement) return;
        templatePath.replaceWith(replacement);
        templatePath.skip();
      },
    },
  };
};
