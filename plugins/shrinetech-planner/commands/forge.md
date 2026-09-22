---
name: forge
description: Phoenix Forge VRAM mode — show which models are resident, or switch the whole box (voice / jarvis / code / big / render).
---
If `$ARGUMENTS` is empty: call the shrinetech-planner tool `forge_mode` and report the current mode, what is resident, free VRAM, and the mode table in one compact list. Do not switch anything.

If `$ARGUMENTS` names a mode (voice, jarvis, crack-voice, chat, code, big, render), optionally followed by `kv=q4|q8|f16` or `ctx=<tokens>`: first call `forge_mode` and say what will be evicted. A switch evicts the model you are talking through, so warn that this session's next reply may fail with "Cannot connect" — that is the switch succeeding, not an error — and that `forge-mode` re-resolves the Planner's tiers afterwards. Then call `forge_switch_mode` with `{mode, kv, ctx, confirm: true}` and report the result.

Never switch to `render` on someone else's behalf without saying that every local model goes down. $ARGUMENTS
