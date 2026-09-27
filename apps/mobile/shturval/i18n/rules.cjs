"use strict";

// Shturval fork: which string literals are interface text. Shared by the Babel
// plugin that swaps in Russian (babel-plugin.cjs) and the scanner that lists
// what is still untranslated (scan.cjs). Only dictionary hits are replaced, so
// these rules mostly guard strings that double as identifiers: route names,
// discriminants, keys, icons and anything compared against.

const path = require("node:path");

const MOBILE = path.resolve(__dirname, "../..");
const WORKSPACE = path.resolve(MOBILE, "../..");
const SCOPES = [
  path.join(MOBILE, "src"),
  path.join(MOBILE, "shturval", "overrides"),
  path.join(WORKSPACE, "packages", "client-runtime", "src"),
  path.join(WORKSPACE, "packages", "shared", "src"),
];

function isTranslatableFile(filename) {
  if (!filename || filename.includes(`${path.sep}node_modules${path.sep}`)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(filename)) return false;
  return SCOPES.some((scope) => filename.startsWith(scope + path.sep));
}

// JSX attributes and object keys whose string values are identifiers.
const IDENTIFIER_NAMES = new Set([
  "className",
  "colorClassName",
  "tintColorClassName",
  "contentContainerClassName",
  "style",
  "testID",
  "nativeID",
  "key",
  "id",
  "identifier",
  "name",
  "screen",
  "initialRouteName",
  "route",
  "routeName",
  "type",
  "kind",
  "variant",
  "tone",
  "mode",
  "size",
  "presentation",
  "icon",
  "systemName",
  "sfSymbol",
  "systemImage",
  "image",
  "assetName",
  "source",
  "href",
  "role",
  "accessibilityRole",
  "autoCapitalize",
  "autoComplete",
  "keyboardType",
  "returnKeyType",
  "textContentType",
  "inputMode",
  "enterKeyHint",
  "value",
  "defaultValue",
  "phase",
  "status",
  "state",
  "event",
  "action",
  "command",
  "shortcut",
  "platform",
  "scheme",
  "url",
  "uri",
  "path",
  "fontFamily",
  "fontWeight",
  "color",
  "tintColor",
  "placement",
]);

// Calls whose string arguments name routes or keys rather than show text.
const IDENTIFIER_CALLS = new Set([
  "navigate",
  "push",
  "replace",
  "reset",
  "jumpTo",
  "popTo",
  "setParams",
  "navigateDeprecated",
  "require",
  "import",
  "get",
  "set",
  "has",
  "delete",
  "getItem",
  "setItem",
  "removeItem",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "split",
  "join",
  "addEventListener",
  "removeEventListener",
  "on",
  "off",
  "emit",
  "querySelector",
  "getElementById",
  "Symbol",
  "useHardwareKeyboardCommand",
  "createNativeStackScreen",
  "localeCompare",
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "trace",
  "assert",
  "captureException",
  "addBreadcrumb",
]);

// Object keys whose string values are shown to a person.
const DISPLAY_KEYS = new Set([
  "title",
  "subtitle",
  "label",
  "shortLabel",
  "longLabel",
  "statusLabel",
  "actionLabel",
  "confirmLabel",
  "cancelLabel",
  "buttonLabel",
  "chipLabel",
  "message",
  "description",
  "detail",
  "details",
  "detailText",
  "placeholder",
  "headerTitle",
  "headerBackTitle",
  "accessibilityLabel",
  "accessibilityHint",
  "aria-label",
  "hint",
  "text",
  "caption",
  "summary",
  "heading",
  "headline",
  "emptyTitle",
  "emptyDetail",
  "emptyMessage",
  "body",
  "footer",
  "helpText",
  "tooltip",
  "badge",
  "subtitleText",
  "titleText",
  "noun",
  "verb",
  "unit",
]);

// .ts modules whose returned strings are presentation copy.
const PRESENTATION_MODULE =
  /(presentation|labels?|copy|format|display|messages?|strings?)[^/\\]*\.ts$/i;

const TEXT_VARIABLE =
  /(label|title|text|message|copy|hint|placeholder|summary|caption|description|detail|heading|headline)s?$/i;

function propertyName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  return undefined;
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
    return propertyName(callee.property);
  }
  if (callee.type === "Import") return "import";
  return undefined;
}

/** Whether a StringLiteral / TemplateLiteral path sits where text is shown. */
function isInterfaceTextPath(p, filename = p.hub?.file?.opts?.filename ?? "") {
  const parent = p.parentPath;
  if (!parent) return false;
  if (!isOutsideErrors(p)) return false;
  if (!isAllowedPosition(p, parent)) return false;
  return isDisplayContext(p, filename);
}

// Errors are data: their messages get matched further on (retry rules, server checks).
function isOutsideErrors(p) {
  return !p.findParent((a) => a.isNewExpression() || a.isThrowStatement());
}

function isDisplayContext(p, filename) {
  let current = p;
  while (current.parentPath) {
    const parent = current.parentPath;
    const node = parent.node;
    if (parent.isJSXAttribute() || parent.isJSXElement() || parent.isJSXFragment()) return true;
    if (parent.isObjectProperty() && node.value === current.node) {
      return DISPLAY_KEYS.has(propertyName(node.key));
    }
    if (parent.isCallExpression() || parent.isOptionalCallExpression()) {
      const callee = node.callee;
      const object = callee.type === "MemberExpression" ? propertyName(callee.object) : undefined;
      if (object === "Alert" || object === "ToastAndroid") return true;
      return false;
    }
    if (
      parent.isConditionalExpression() ||
      parent.isLogicalExpression() ||
      parent.isTemplateLiteral() ||
      parent.isArrayExpression() ||
      parent.isJSXExpressionContainer() ||
      parent.isTSAsExpression() ||
      parent.isTSSatisfiesExpression() ||
      parent.isParenthesizedExpression()
    ) {
      current = parent;
      continue;
    }
    if (parent.isVariableDeclarator()) {
      // Only variables named as copy; others may be compared later.
      return node.id.type === "Identifier" && TEXT_VARIABLE.test(node.id.name);
    }
    if (parent.isReturnStatement() || parent.isArrowFunctionExpression()) {
      return filename.endsWith(".tsx") || PRESENTATION_MODULE.test(filename);
    }
    return false;
  }
  return false;
}

function isAllowedPosition(p, parent) {
  const pn = parent.node;
  switch (pn.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
    case "ImportExpression":
    case "TSLiteralType":
    case "TSEnumMember":
    case "BinaryExpression":
    case "SwitchCase":
    case "TSExternalModuleReference":
    case "Directive":
    case "DirectiveLiteral":
    case "TaggedTemplateExpression":
      return false;
    case "ObjectProperty":
    case "ObjectMethod":
      if (pn.key === p.node && !pn.computed) return false;
      if (pn.value === p.node && IDENTIFIER_NAMES.has(propertyName(pn.key))) return false;
      break;
    case "ClassProperty":
    case "PropertyDefinition":
      if (pn.key === p.node) return false;
      break;
    case "MemberExpression":
    case "OptionalMemberExpression":
      if (pn.property === p.node) return false;
      break;
    case "JSXAttribute":
      if (IDENTIFIER_NAMES.has(propertyName(pn.name))) return false;
      break;
    case "JSXExpressionContainer": {
      const attr = parent.parentPath?.node;
      if (attr?.type === "JSXAttribute" && IDENTIFIER_NAMES.has(propertyName(attr.name)))
        return false;
      break;
    }
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression":
      if (pn.callee === p.node) return false;
      if (IDENTIFIER_CALLS.has(calleeName(pn.callee))) return false;
      break;
    case "AssignmentExpression":
      if (
        pn.left?.type === "MemberExpression" &&
        IDENTIFIER_NAMES.has(propertyName(pn.left.property))
      ) {
        return false;
      }
      break;
    default:
      break;
  }
  // A literal inside a comparison further up (x === (a ? "A" : "B")) is data.
  const conditional = p.findParent(
    (ancestor) => !ancestor.isConditionalExpression() && !ancestor.isLogicalExpression(),
  );
  if (conditional && conditional !== parent && conditional.isBinaryExpression()) return false;
  return true;
}

/** "Working for ${x}" → "Working for {0}" (the dictionary key for a template). */
function templateKey(node) {
  return node.quasis
    .map((q, i) => q.value.cooked + (i < node.expressions.length ? `{${i}}` : ""))
    .join("");
}

module.exports = { isTranslatableFile, isInterfaceTextPath, templateKey };
