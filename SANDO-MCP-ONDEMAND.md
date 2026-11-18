# Sando on-demand MCP tools (spec)

Port 2 from the DeepSeek Harness study (`docs/dsh-study-2026-11-17.md` §3, branch `fleet/dsh-study-20261117`),
Planner SAN-4472. Idea from dsh (MIT): names plus short summaries up front, schemas on request. No code copied.

## 1. Why

Every MCP tool's full schema goes into every request. The Planner plugin now has **80 tools** (51 when the study was
written). Their names, descriptions and schemas come to 68.5k characters. On CRACK that is about 18k of the 22.6k
prompt tokens of a lean run's first request (measured in the A/B below). A coding task that never touches the
Planner pays for it on every step, and a 32k model loses more than half its window before the task starts.

## 2. Behaviour

```sh
sando ...                       # default since 2026-11-18, every profile: catalog + load_tools
SANDO_MCP_TOOLS=all sando ...   # off switch = upstream: every MCP schema in every request (alias: eager)
# ondemand / on-demand = the default spelled out. Any other value is a startup error.
```

Default for every prompt profile (default, lean, lean-local) since 2026-11-18 (Chuck's form, SAN-4472); it was
opt-in before. With `ondemand`:
- **The request carries no MCP schemas up front.** It carries one tool, `load_tools`, whose description is the
  catalog:
  - grouped by server, one line per tool;
  - each line is the tool's name plus the first sentence of its description, cut to at most 160 characters.
- **`load_tools({ names: [...] })` accepts:**
  - full names;
  - a short name that matches exactly one tool (`get_task`);
  - `<prefix>*` for a whole server.
  - A comma-separated string works too (local models send that).
  - Unknown names get "Did you mean …" (substring or ≤ 2 edits).
- **Loaded tools join the tool list from the next request on**, with their full schemas, for the rest of the session.
  Once nothing is left to load, `load_tools` drops out.
- **A direct call to a listed tool loads it.** The call runs, and the schema follows on the next request. A model
  that guesses the arguments from the catalog therefore gets the server's answer or error, then the schema.
- **Never deferred:** the bundled `node_repl` and computer-use servers (runtime features, not catalog tools) and all
  built-in tools.
- **Where it applies:** at the provider-request boundary (`turn-loop.ts` and the compaction request in
  `compact-active.ts`, so both send the same tool prefix). `getTools()` is unchanged, so subagent inheritance, the
  plugin-reference reminder and persistence see every tool as before.
- **Where the code is:**
  - `core/src/mcp/on-demand.ts` (catalog, resolution, `load_tools` entry);
  - `core/src/runtime/methods/mcp.ts` (registers `load_tools` after the MCP tools);
  - `core/src/runtime/methods/mcp-on-demand.ts` (the boundary filter, and loading on a direct call).
- The lean profile keeps `load_tools`.
- **Logs:**
  - `mcp.ondemand.deferred` (count) once per session;
  - `mcp.ondemand.load` (loaded / already loaded / unknown) per call.

**Prompt cache.** Loading a tool changes the tool list, and llama.cpp chat templates render tools at the top of the
prompt. So each `load_tools` step costs one re-prefill of the conversation so far. Loads are rare (once per tool per
session) and usually happen early, when the prompt is short.

**Not covered:**
- After a session resume the loaded set starts empty: the model loads again (one extra step).
- The catalog is built when the MCP tools register. A server that adds tools mid-session is not re-listed.
- Subagents inherit MCP tools by name as before, and their own requests are filtered the same way.

## 3. Tests

- `core/test/sando-mcp-ondemand.test.mjs` (9): the knob (unset = ondemand), what is deferrable, the 160-character summaries,
  catalog layout, projection, name resolution (full / short / wildcard / typo suggestions), the handler, and loading
  on a direct call. Also checks that lean keeps `load_tools`.
- `cli/test/sando-mcp-ondemand.e2e.test.mjs` (7), run against the built CLI with a scripted model and a scripted stdio
  MCP server (`cli/test/fake-mcp-server.mjs`, 40 Planner-sized tools) loaded as a plugin:
  - default (unset) = ondemand in the default, lean and lean-local profiles;
  - `all` / `eager` = every schema, no `load_tools`, in all three profiles (the off switch);
  - the first request is at least 80 % smaller in MCP bytes and the built-ins are untouched;
  - load_tools → schema → call → result;
  - a direct call works and loads the tool;
  - suggestions, and the wildcard retires `load_tools`;
  - lean;
  - a bad value fails before any request.
- `cli/test/sando-redteam.test.mjs`:
  - `REDTEAM_WITH_LOAD_TOOLS=1` adds the catalog to the live suite's tool list;
  - a deterministic case shows that a hostile MCP description stays one line of at most 160 characters. The words
    themselves are kept, not sanitised; that is the same trust as upstream, which sends the full description.

## 4. A/B

See `FLEET-REPORT.md` (2026-11-18 entry) for the numbers. The kit is `~/apps/fleet/work/sando-mcp-ondemand/`
(`run.sh`, `queue.sh`, `mcpstats.py`, tasks `m1`–`m3`, hidden checks), and the raw runs are in
`/mnt/storage/scratch/sando-mcp-ondemand-1118/`.

- **Setup.** CRACK `qwen3.8-27b` at n_ctx 131,072 on card 1 under `gpu-job-lock`, lean-local profile, dsh-box
  (Docker `--network none`, 3 CPUs, strace).
- **The Planner stand-in.** Every run has the Planner plugin's 80 real tool schemas, captured read-only via
  `tools/list` on 2026-11-18. A stdio stub serves them with canned answers. There are no Planner writes and no network.
- **Arms.** `all` and `ondemand` use the same build and are interleaved.
- **Tasks:**
  - m1: read a task's title;
  - m2: add a note and record its id;
  - m3: list and filter tasks;
  - five lean-bench coding tasks that need no MCP tool.
- **Measured:**
  - first-request prompt tokens;
  - total prompt tokens;
  - success (hidden checks, which include the stub's call log);
  - `load_tools` and MCP calls;
  - MCP/`load_tools` tool-call errors.
