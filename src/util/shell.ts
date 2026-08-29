/** Quote one value for literal use as a POSIX shell word. */
export function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
