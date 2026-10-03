"use strict";

// Helm fork: shows the mobile app in Russian when the phone's language is
// Russian, without editing upstream files. At bundle time, every interface
// string found in ru.json becomes `helmRussian ? "Русский" : "English"`;
// helmRussian is read once from the system language (locale.ts). rules.cjs
// decides which literals are interface text.
//
// Dictionary values may reference template expressions by index — {0} — and
// pick a Russian plural form from one of them — {0|файл|файла|файлов}.

const path = require("node:path");
const { isTranslatableFile, isInterfaceTextPath, templateKey } = require("./rules.cjs");

const WORKSPACE = path.resolve(__dirname, "../../../..");
const DICTIONARY_PATH = path.join(__dirname, "ru.json");
const PLURAL_MODULE = path.join(__dirname, "plural.ts");
const LOCALE_MODULE = path.join(__dirname, "locale.ts");

// Metro's transform cache is shared by every checkout on the machine, so the
// emitted import is relative to the file: an absolute path would send another
// worktree's build to this checkout's modules.
function moduleSpecifier(filename, modulePath) {
  if (!filename) return modulePath;
  const relative = path.relative(path.dirname(filename), modulePath).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}
const LOCALE_BINDING = "__helmRu";
const TOKEN = /\{(\d+)(?:\|([^|}]*)\|([^|}]*)\|([^|}]*))?\}/g;
const HAS_TOKEN = /\{\d+[|}]/;

// Keys are stored trimmed with single spaces; the source's own edge
// whitespace (" and ", "Tap ") is put back around the translation.
const normalize = (text) => text.trim().replace(/\s+/g, " ");
const edges = (text) => ({ lead: text.match(/^\s*/)[0], trail: text.match(/\s*$/)[0] });

// What JSX renders for a text child: lines lose the whitespace around line
// breaks, blank lines drop out, and the rest join with single spaces.
function renderedJsxText(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const last = lines.length - 1;
  return lines
    .map((line, index) => {
      let kept = line.replace(/\t/g, " ");
      if (index !== 0) kept = kept.replace(/^ +/, "");
      if (index !== last) kept = kept.replace(/ +$/, "");
      return kept;
    })
    .filter((line) => line !== "")
    .join(" ");
}

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

  // Widget layouts are serialized into the widget extension on their own and
  // cannot reach an imported binding, so they ask Intl inline instead.
  function russianTest(state) {
    if (state.allowImports) {
      state.needsLocale = true;
      return t.identifier(LOCALE_BINDING);
    }
    return t.logicalExpression(
      "&&",
      t.binaryExpression(
        "===",
        t.unaryExpression("typeof", t.identifier("Intl")),
        t.stringLiteral("object"),
      ),
      t.callExpression(t.memberExpression(t.regExpLiteral("^ru\\b", "i"), t.identifier("test")), [
        t.memberExpression(
          t.callExpression(
            t.memberExpression(
              t.newExpression(
                t.memberExpression(t.identifier("Intl"), t.identifier("DateTimeFormat")),
                [],
              ),
              t.identifier("resolvedOptions"),
            ),
            [],
          ),
          t.identifier("locale"),
        ),
      ]),
    );
  }
  const choose = (state, russian, english) =>
    t.conditionalExpression(russianTest(state), russian, english);

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
          state.needsLocale = false;
          // Widget layouts are serialized into the widget extension on their
          // own, so they cannot import the plural helper.
          state.allowImports =
            !/[\\/](src[\\/]widgets[\\/]|helm[\\/]overrides[\\/]AgentActivity)/.test(
              state.filename ?? "",
            );
        },
        exit(programPath, state) {
          if (state.needsPlural) {
            programPath.unshiftContainer(
              "body",
              t.importDeclaration(
                [t.importSpecifier(t.identifier("__helmRuPlural"), t.identifier("ruPlural"))],
                t.stringLiteral(moduleSpecifier(state.filename, PLURAL_MODULE)),
              ),
            );
          }
          if (state.needsLocale) {
            programPath.unshiftContainer(
              "body",
              t.importDeclaration(
                [t.importSpecifier(t.identifier(LOCALE_BINDING), t.identifier("helmRussian"))],
                t.stringLiteral(moduleSpecifier(state.filename, LOCALE_MODULE)),
              ),
            );
          }
        },
      },
      JSXText(textPath, state) {
        if (!state.enabled) return;
        const raw = textPath.node.value;
        const value = lookup(normalize(raw), state);
        if (typeof value !== "string" || HAS_TOKEN.test(value)) return;
        const { lead, trail } = edges(raw);
        textPath.replaceWith(
          t.jsxExpressionContainer(
            choose(
              state,
              t.stringLiteral(renderedJsxText(lead + value + trail)),
              t.stringLiteral(renderedJsxText(raw)),
            ),
          ),
        );
        textPath.skip();
      },
      StringLiteral(literalPath, state) {
        if (!state.enabled) return;
        const raw = literalPath.node.value;
        const value = lookup(normalize(raw), state);
        if (typeof value !== "string") return;
        if (!isInterfaceTextPath(literalPath, state.filename)) return;
        const russian = t.stringLiteral(edges(raw).lead + value + edges(raw).trail);
        const choice = choose(state, russian, t.stringLiteral(raw));
        literalPath.replaceWith(
          literalPath.parentPath.isJSXAttribute() ? t.jsxExpressionContainer(choice) : choice,
        );
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
        templatePath.replaceWith(choose(state, replacement, t.cloneNode(templatePath.node, true)));
        templatePath.skip();
      },
    },
  };
};
