import { describe, expect, it } from "vite-plus/test";

import { ruPlural } from "./plural";

describe("ruPlural", () => {
  it("picks the Russian form for a count", () => {
    const forms = ["файл", "файла", "файлов"] as const;
    expect([0, 1, 2, 4, 5, 11, 12, 21, 22, 25, 101, 111].map((n) => ruPlural(n, ...forms))).toEqual(
      [
        "файлов",
        "файл",
        "файла",
        "файла",
        "файлов",
        "файлов",
        "файлов",
        "файл",
        "файла",
        "файлов",
        "файл",
        "файлов",
      ],
    );
  });
});
