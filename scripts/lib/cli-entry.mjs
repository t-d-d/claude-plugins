import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Whether a module is the process entry point: the guard between a script's
 * exports and its `main()`. A miss is silent (`main()` never runs and the
 * process exits 0), so the comparison is careful.
 *
 * ## Why neither comparison is a string compare
 *
 * `import.meta.url` and `process.argv[1]` describe the same file in two
 * spellings, and node produces both differently:
 *
 *   - `pathToFileURL` rather than `file://` + the path, because the URL
 *     percent-encodes and the argv path does not: a checkout under a path with
 *     a space fails the naive compare.
 *   - `realpathSync` as the second try, because node resolves the MAIN
 *     module's symlinks before building `import.meta.url` and leaves
 *     `process.argv[1]` the spelling it was handed: a workspace reached
 *     through a link — a runner whose checkout is linked elsewhere, a macOS
 *     `/tmp` — disagrees with itself otherwise.
 *
 * Both tries are exact. There is no basename fallback: `argv1.endsWith('/x.mjs')`
 * answers "some file called that" rather than "this file", so it says yes to a
 * same-named script anywhere on disk — a looser answer in a guard whose wrong
 * answers are already invisible.

 *
 * @param {string} moduleUrl `import.meta.url` of the module asking.
 * @param {string | undefined} argv1 `process.argv[1]`, absent when node was
 *   given no script at all (`node -e`, a REPL) — never the entry point.
 * @returns {boolean}
 */
export const isCliEntry = (moduleUrl, argv1) => {
  if (argv1 === undefined) return false;
  try {
    if (moduleUrl === pathToFileURL(argv1).href) return true;
    // `realpathSync` throws on a path that does not exist, which is not a
    // question this guard answers: an argv path we cannot resolve is not this
    // module, and the catch below is what says so.
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
};
