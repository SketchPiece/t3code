import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const presetPath = require.resolve("babel-preset-expo");
const babel = require(require.resolve("@babel/core", { paths: [presetPath] })) as {
  transformSync: (code: string, options: object) => { code: string } | null;
};
const plugin = require("./babel-plugin.cjs");

const FILE = NodePath.resolve(import.meta.dirname, "../../src/features/example.tsx");

function translate(code: string, dictionary: Record<string, string>, filename = FILE): string {
  const result = babel.transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[plugin, { dictionary }]],
    generatorOpts: { jsescOption: { minimal: true } },
  });
  return result?.code ?? "";
}

describe("Russian interface text", () => {
  it("translates JSX text, text props and alert strings", () => {
    const out = translate(
      `const a = <Button title="Settings">  Add environment  </Button>;
       Alert.alert("Delete thread?", "Cancel");`,
      {
        Settings: "Настройки",
        "Add environment": "Добавить окружение",
        "Delete thread?": "Удалить тред?",
        Cancel: "Отмена",
      },
    );
    expect(out).toContain('title="Настройки"');
    expect(out).toContain("  Добавить окружение  ");
    expect(out).toContain('"Удалить тред?"');
    expect(out).toContain('"Отмена"');
  });

  it("leaves strings that name routes, keys, types or compared values", () => {
    const dictionary = { Settings: "Настройки", Working: "Работает" };
    const out = translate(
      `navigation.navigate("Settings");
       const route = { name: "Settings", screen: "Settings" };
       if (label === "Working") {}
       switch (x) { case "Working": break; }
       type Label = "Working";
       const map = { Settings: 1 };
       <Icon name="Settings" />;`,
      dictionary,
    );
    expect(out).not.toContain("Настройки");
    expect(out).not.toContain("Работает");
  });

  it("rebuilds templates with Russian plural forms", () => {
    const out = translate("const label = `${count} file${count === 1 ? '' : 's'} changed`;", {
      "{0} file{1} changed": "{0} {0|файл изменён|файла изменено|файлов изменено}",
    });
    expect(out).toContain(
      '__shturvalRuPlural(count, "файл изменён", "файла изменено", "файлов изменено")',
    );
    expect(out).toMatch(/import \{ ruPlural as __shturvalRuPlural \} from ".*plural\.ts"/);
    expect(out).not.toContain("changed");
  });

  it("only touches the app's own sources", () => {
    const out = translate(
      'const t = "Settings";',
      { Settings: "Настройки" },
      "/tmp/elsewhere/x.ts",
    );
    expect(out).toContain('"Settings"');
  });
});
