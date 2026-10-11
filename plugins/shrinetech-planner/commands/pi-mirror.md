---
name: pi-mirror
description: Back up every princetrunks GitHub repo to the Pi 5 (theAIRaspPi) — status, refresh the repo list, or run the mirror now.
---
The Pi 5 (`pi@theairasppi`) keeps a git mirror of every princetrunks GitHub repo (`~/shared/Repositories/repositories`, nightly 04:30).
Drive it ONLY through the forge command `pi-mirror` (in `~/bin`, run it with your shell tool):

- `pi-mirror status` — counts, last run summary, and GitHub repos not yet on the Pi. Always run this first and report it.
- `pi-mirror refresh` — rebuild `repos.txt` from GitHub (`gh`) and copy it to the Pi (old copy kept as `repos.txt.bak`).
- `pi-mirror run` — refresh, then start the mirror on the Pi in the background (returns at once; `--dry-run` to preview).
- `pi-mirror log` — tail of the current/last run. A run takes ~2-30 min; check the log, do not wait in a loop.

If `$ARGUMENTS` is empty or "status": run `pi-mirror status`. If it says "run", "sync", "backup" or "update": run `pi-mirror run`, then
`pi-mirror log` once a minute or two later, and report cloned / fetched / skipped / failed. Rules: never delete or reset anything on the Pi,
never edit `mirror_repos.sh`, never `git push` from the mirror; a SKIP-DIRTY repo (zenime) is expected — report it, do not "fix" it. $ARGUMENTS
