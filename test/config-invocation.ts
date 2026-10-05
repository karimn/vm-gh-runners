/**
 * The `bash -c '...config.sh...'` command the runner user runs, and the
 * positional argument it reads as `--labels "$5"` (the fifth after `_`).
 */
export const configInvocation = (script: string): { configCmd: string; labelsArg: string } => {
  const m = /bash -c '([^']*config\.sh[^']*)' _ \\\n\s*"\$DIR" '[^']*' "\$TOKEN" "\$NAME" '([^']*)'/.exec(script);
  if (!m) throw new Error(`no config.sh invocation in:\n${script}`);
  return { configCmd: m[1]!, labelsArg: m[2]! };
};
