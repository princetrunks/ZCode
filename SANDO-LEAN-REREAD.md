# Sando lean: re-reads are served, not refused (SAN-4472, 2026-11-17)

Source: the Sando-vs-dsh head-to-head of 11-17 (`~/apps/deepseek-harness/shrinetech/h2h/RESULTS.md`). Sando's
lean profile refused 33 Reads with "Wasted call — file unchanged since your last Read". dsh never refuses a read;
its guard only nudges after 3/5/8 identical calls.

## Behaviour (lean profile only; `default` keeps upstream)
- A Read of a range the model already read, unchanged on disk, returns the content again, with a
  `<system-reminder>` above it: "Unchanged since you last read it this turn (read N times). Shown again below."
- At the 3rd and 5th read the note is firmer: "work from the content below … at 8 reads it is refused".
- The 8th read of the same unchanged range in one turn is refused without content, as a loop
  (`Refused: this is read 8 of the same unchanged file range this turn …`).
- The count is per range (`file_path` + `offset` + `limit`) and restarts when the file changes or a new user turn
  starts.
- **A Read after the model's own Edit/Write is a first read.** Edit/Write refresh the read state, so upstream treats
  the next Read as "unchanged" and refuses it, although the model has never seen the edited file. That is the
  common case: of the head-to-head's refusals that could be classified, 24 of 31 were reads of the model's own edit
  and 7 were true re-reads. In this A/B's base arm it was 17 of 20.
- Where: `core/src/tool/handlers/read.ts` (`READ_REPEAT_FIRM_AT` = [3, 5], `READ_REPEAT_REFUSE_AT` = 8).
  `ToolExecutionContext.readRepeatPolicy` is `"nudge"` when the runtime resolves the lean profile for the call's
  model (`runtime-tools.ts`), and `"refuse"` otherwise.

## `SANDO_LEAN_SMALLEST_EDIT=on|off` (A/B knob, default on)
`off` drops "with the smallest correct edit" from lean step 2, which was suspected of causing the t5 misses. An
unknown value fails at startup.

## Tests
- `core/test/sando-read-repeat.test.mjs` runs the real handler on a temp dir:
  - default keeps the stub;
  - the nudge text at 2/3/5;
  - refusal at 8 and 9;
  - the count is per range and restarts on a new turn or a file change;
  - a read after Edit carries no note.
- `cli/test/sando-read-repeat.e2e.test.mjs` runs the built CLI against a scripted model:
  - lean: 8 reads, of which 7 carry the content and the 8th is refused;
  - default gives "Wasted call";
  - a real Edit then Read shows the edit (upstream: "Wasted call");
  - the knob, and that a bad knob value exits before any request.
- `core/test/sando-prompt-profile.test.mjs`: the knob.

## A/B on CRACK (2026-11-17/18, kit `~/apps/fleet/work/sando-lean-reread/`, raw `/mnt/storage/scratch/sando-lean-reread-1117/`)
Setup: the h2h box (dsh-box, Docker `--network none`, image 0.2 with rg + git, 3 CPUs), CRACK `qwen3.8-27b`
(n_ctx 131,072), `lean-local`, 8,192 output cap, 1,200 s limit, and the hidden checks. Arms ran interleaved under
`gpu-job-lock` on card 1, with 0 outbound in every run.

The arms:
- `base` = `sando` @ a53d516e;
- `new` = the first nudge build;
- `new2` = with the read-after-Edit fix (1b568e00);
- `new-nosmall` = `new` + `SANDO_LEAN_SMALLEST_EDIT=off`.

**Re-read subset** (the CRACK tasks that hit "Wasted call" in the h2h: t3 t5 t6 t7 t8)

| arm | runs | pass | total s | median s | prompt tok | "Wasted call" | nudged | loop refusals |
|---|---|---|---|---|---|---|---|---|
| base | 20 | 18/20 | 3,930 | 74 | 9.64 M | 20 | – | – |
| new | 10 | 7/10 | 2,195 | 92 | 4.76 M | 0 | 13 | 0 |
| new2 | 10 | 7/10 | 2,551 | 185 | 8.49 M | 0 | 0 | 0 |

**Honest reading: this does not show the change helping on CRACK, and it does not show it hurting either.**
- Of the 6 new/new2 failures, 4 are t5, where no re-read happened. Those runs sent byte-identical requests to base
  (only the work-dir path differed), so they are sampling noise at temp 1.0. Base t5 was 3/4 and the new arms 0/4.
- The other two failures:
  - new t8 r2: nudged 6 times; it missed a quoted-value case.
  - new2 t7 r3: no nudge; a list-ordering bug.
- Wall time is dominated by a few long runs in every arm, and none of them is a read loop:
  - base t8 r3: 1,163 s;
  - new t3 r1: 406 s, about 25 `python3 -c` regex experiments;
  - new2 t6 r3: 1,067 s, 110 Bash calls, no nudge or refusal.
- The new arms never refused and never hit the loop cap. The "cat after a refusal" fallback is gone (base: 7 bash
  cat/sed of a file Read had already shown).
- n is 10–20 per arm and CRACK's run-to-run spread is 5–25× on the same task. Proving a time or success effect would
  take far more runs, on a model that loses its earlier reads (Bonsai, whose README loop prompted this).

**Smallest-edit A/B** (`new` vs `new-nosmall`)
- t5 alone: 1/8 with the phrase vs 2/6 without it. Too small to call. Both are well below dsh's 3/4 in the h2h.
- Tasks run in both arms (t1–t4, t6–t9; `new` = A's runs plus C):
  - with the phrase: 11/12 pass, median 78 s, 4.81 M prompt tokens;
  - without it: 8/8 pass, median 38 s, 1.86 M tokens, at 1 rep.
- That leans toward dropping the phrase, but at this n it is a lean, not a result.

## Red-team (white hat, kit vendored in `cli/test/redteam`)
- The deterministic cases pass in the cli suite.
- The live suite ran on CRACK (43 cases; it stubs every tool call, so it tests the lean system prompt):

| prompt | pass | fail | review | error |
|---|---|---|---|---|
| default (`SANDO_LEAN_SMALLEST_EDIT` on, prompt unchanged by this branch) | 11 | 31 | 1 | 0 |
| knob off | 12 | 28 | 1 | 2 |

- The 2 errors are llama-server 500s ("Failed to parse tool call arguments as JSON"), on the engine side.
- CRACK has no stored baseline; Lily 9B's is 9/33.
- Dropping the phrase does not weaken the prompt. The low hold rate is the model plus yolo mode, as before.
- Raw results: `/mnt/storage/scratch/sando-lean-reread-1117/redteam-{on,off}.json`.
