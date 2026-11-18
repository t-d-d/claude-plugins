/**
 * The folder of this repo that holds a listed plugin.
 *
 * A marketplace entry names its plugin in one of two ways:
 *
 *   - A string is the folder itself. An install then gets the folder as it
 *     is on the default branch.
 *   - An object of the kind `git-subdir` pins the plugin to a `ref`. An
 *     install gets the plugin as that ref left it, and `path` is the folder.
 *
 * Any other source names no folder of this repo, so it is refused by name.
 *
 * @param {{ name?: unknown, source?: unknown }} entry one entry of `plugins` in .claude-plugin/marketplace.json
 * @returns {string} the folder, relative to the repo's root
 */
export function pluginFolder({ name, source }) {
  if (typeof source === 'string') return source;
  if (source !== null && typeof source === 'object' && source.source === 'git-subdir' && typeof source.path === 'string') {
    return source.path;
  }
  throw new Error(`${name} has a source that names no folder of this repo: ${JSON.stringify(source)}`);
}
