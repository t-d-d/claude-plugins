// The prompt half of the tokenising hook, as Claude Code function hooks
// (early access, Claude Code 2.1.280+). A command hook cannot replace a
// prompt, only block it; these rewrite it on the way in, so an operator pastes
// an address once and the model reads a handle.
//
// prompt.submit takes a typed prompt; session.receive takes a delivery (a
// relayed message, a peer session's message, a Remote Control prompt).
// prompt.submit's rewrite of a delivery reaches the command hook but not the
// model, so a delivery is rewritten before it is queued.
//
// Loads only when the session runs with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1.
// Elsewhere it is inert and the UserPromptSubmit command hook blocks the
// prompt instead.
//
// The module runs without Node: no imports, and `$` only as $.noun.member.
// The tokenising lives in the script, reached through $.process.run, so its
// handles land in the vault the tool hooks read. The script is the plugin's
// own, named from the plugin's folder: the session's directory is whatever
// project the session works on.
const SCRIPT = "hooks/pii-tokenise.mjs";

const HELD = "Held back: a message delivered to this session carried a personal address that could not be tokenised, so the model must not read it. Read its source through a tool instead: tool output is tokenised.";

const input = (event, session, text) =>
  JSON.stringify({ hook_event_name: event, session_id: session, prompt: text });

// The script's rewrite: a string, null for nothing to rewrite, undefined where
// it failed. Throws on output that is not JSON.
function answer(res) {
  if (res.exitCode !== 0) return undefined;
  if (!String(res.stdout ?? "").trim()) return null;
  const text = JSON.parse(res.stdout).text;
  return typeof text === "string" ? text : undefined;
}

export function register(on) {
  on("prompt.submit", async ($, e, next) => {
    if (!String(e.text).includes("@")) return next(e);
    let text;
    try {
      text = answer(await $.process.run(["node", `${$.plugin.root}/${SCRIPT}`], { stdin: input("PromptRewrite", await $.session.id(), e.text) }));
    } catch {
      // Pass on unchanged: the UserPromptSubmit command hook blocks it, and
      // the operator is there to re-send it.
    }
    return next(typeof text === "string" ? { ...e, text } : e);
  });

  on("session.receive", async ($, e, next) => {
    if (!String(e.text).includes("@")) return next(e);
    let text;
    try {
      text = answer(await $.process.run(["node", `${$.plugin.root}/${SCRIPT}`], { stdin: input("DeliveryRewrite", await $.session.id(), e.text) }));
    } catch {
      // The script failed; below decides.
    }
    if (typeof text === "string") return next({ ...e, text });
    if (text === null) return next(e);
    // The script failed, so the delivery would reach the model raw, and nobody
    // may be there to re-send it.
    return next({ ...e, text: HELD });
  });
}
