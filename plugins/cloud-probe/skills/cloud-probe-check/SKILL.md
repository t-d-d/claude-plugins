---
name: cloud-probe-check
description: Test skill from the cloud-probe plugin. Use only when asked whether the cloud-probe plugin loaded. It does nothing else.
---

# cloud-probe check

If you can read this, the cloud-probe plugin's own skill loaded in this session.

Report the contents of `${TMPDIR:-/tmp}/cloud-probe/session-start.log` if it exists, and say whether a skill named `cloud-probe-payload` is in your skill list.
