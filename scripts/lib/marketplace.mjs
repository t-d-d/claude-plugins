import { normalize } from 'node:path';

/**
 * The folder of this repo that holds a listed plugin.
 *
 * A marketplace entry names its plugin in one of two ways:
 *
 *   - An object of the kind `git-subdir` pins the plugin to a `ref`. An
 *     install gets the plugin as that ref left it, and `path` is the folder.
 *     Every entry of this repo's marketplace is of this kind.
 *   - A string is the folder itself. An install then gets the folder as it
 *     is on the default branch.
 *
 * Any other source names no folder of this repo, so it is refused by name.
 *
 * @param {{ name?: unknown, source?: unknown }} entry one entry of `plugins` in .claude-plugin/marketplace.json
 * @returns {string} the folder, relative to the repo's root, with no leading `./`
 */
export function pluginFolder({ name, source }) {
  if (typeof source === 'string') return normalize(source);
  if (source !== null && typeof source === 'object' && source.source === 'git-subdir' && typeof source.path === 'string') {
    return normalize(source.path);
  }
  throw new Error(`${name} has a source that names no folder of this repo: ${JSON.stringify(source)}`);
}
