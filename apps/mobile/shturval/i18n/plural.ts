// Shturval fork: Russian plural forms for the translation plugin. A dictionary
// value like "{0} {0|файл|файла|файлов}" compiles to ruPlural(count, …).
export function ruPlural(count: unknown, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(Number(count)));
  const lastTwo = n % 100;
  const last = n % 10;
  if (lastTwo > 10 && lastTwo < 20) return many;
  if (last === 1) return one;
  if (last > 1 && last < 5) return few;
  return many;
}
