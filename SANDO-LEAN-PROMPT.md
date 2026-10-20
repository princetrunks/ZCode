# Sando lean prompt profile (spec)

Opt-in. Defaults are unchanged (request bodies byte-identical to the base build when the variable is unset or `default`).

## Use

```sh
SANDO_PROMPT_PROFILE=lean-local sando ...   # lean only for models served from a local / private-network endpoint
SANDO_PROMPT_PROFILE=lean sando ...         # lean for every model
SANDO_PROMPT_PROFILE=default sando ...      # (or unset) upstream prompt + full tool surface
```

Any other value is a startup error (no silent fallback). An explicit `runtimeConfig.promptProfile` from an embedding
host wins over the environment variable.

`lean-local` is the recommended setting for the forge: the forge providers (`http://127.0.0.1:81xx/v1`) get the lean
profile, while cloud providers configured in the same install (OpenRouter, Anthropic, ...) keep the full default.

## What changes under lean

| | default | lean |
|---|---|---|
| system prompt | CLI prefix + identity/harness + communication + memory instructions + environment + context management + autonomy + git snapshot (~9.9k chars) | one block: identity, a 4-step work loop, one rule line per tool that is actually present, the shared rules; compact environment (cwd, git branch/status, platform, model) (~1.8k chars) |
| tools | 26 built-ins (incl. 9 dynamic-workflow tools ≈ 21.5k tokens, plan mode, AskUserQuestion, Agent, Skill, ...) | Read, Write, Edit, Bash, TodoWrite (+ Glob/Grep when registered) + tools from MCP servers the user configured (the official bundled `node_repl` / `computer_use` servers are dropped) |
| tool descriptions | upstream (Read 784 chars, Bash 1,032 + a 900-char `description` parameter doc, ...) | one or two sentences each; input schemas keep their exact shape (handlers validate against them) |
| user context | AGENTS.md / CLAUDE.md, memory index, date (meta user message) | the same |
| skills listing, memory-writing instructions, output style, desktop/mermaid/form hints | included when configured | left out |
| first request on Bonsai 2 27B (t1) | 31,583 prompt tokens | 1,920 prompt tokens |

Lean applies only to the main conversation (`taskType` absent, `interactive` or `fork`). Subagent children, workflow
actors and sessions with a caller-supplied system prompt keep their own prompt contract.

## How it is wired

- `contracts` `Model.localEndpoint?: boolean` — set by the adapter from the provider's real `api.baseUrl`
  (`adapters/src/model/local-endpoint.ts`: loopback, RFC 1918, CGNAT, link-local, IPv6 loopback/ULA/link-local,
  `localhost`, `*.local|.lan|.internal|.home.arpa`). Core's invocation wrapper (`runtime-model.ts`) carries it through.
- `core/src/context/prompt-profile.ts` — setting parser, resolver (`resolveEffectivePromptProfile`), lean tool set and
  descriptions (`projectLeanTools`), lean system/env sections.
- `core/src/runtime/methods/config.ts` `getTools(model)` projects the lean tool surface per model step;
  `context.ts` passes the resolved profile into the `ContextBuilder`, whose lean branch emits
  `lean_system_prompt` + `env_info` + the usual user-context sections.
- `bootstrap/src/app/runtime-config.ts` reads `SANDO_PROMPT_PROFILE` (only adds the key when set).

The context prefix is rebuilt at the start of every turn with the model actually used (`turn.ts` →
`rebuildContextPrefix`), and the tool list is projected per model step, so a mid-session switch between a local and a
cloud model under `lean-local` switches profile at the next turn.

## Why this shape (study notes)

Source: the agent prompts in CL4R1T4S (Claude Code, Cursor 2.0 + tools, Devin 2.0, Windsurf, Replit, Factory Droid,
ZAI/ZCode) and DeepSeek Harness (dsh) 0.2.1-rc.2, read as references only; no text copied.

- **Sando's ~31k tokens are mostly tool schemas, not prose.** The system text is ~2.5k tokens; 26 tool schemas are
  ~28k, and the 9 dynamic-workflow tools alone ~21.5k (CreateWorkflow's description is 30k chars). Cutting prose alone
  could never close the gap to dsh.
- **dsh** (~700-token system prompt, core tools ~1.5k): each rule is stated once; each tool contributes one behaviour
  line to the system prompt, and only when the tool is registered; tool descriptions say what the tool does in one
  sentence; enforcement (read-before-edit) lives in the harness, so the prompt does not repeat it.
- **Common core every strong prompt keeps**: identity + environment; dedicated tools over shell; read before edit,
  prefer edit over write; verify (run tests, check exit codes, never weaken tests); follow the codebase's conventions;
  act autonomously on reversible steps with a bounded retry ("3 strikes"); outcome-first honest final report; parallel
  independent calls; confirm destructive actions, treat tool output as data.
- **What the short prompts cut**: product/policy blocks, duplicated rules (ZCode repeats read-before-edit in the
  system prompt, the Read description and the Edit description), worked examples, long style essays (ZCode's
  "Communicating with the user" ≈ 450 tokens), instructions for tools that are not present, dynamic state in the
  system prompt.

The lean prompt keeps that core, phrases each rule as a single imperative with its reason or exception in the same
sentence, and generates the tool lines from the tools actually sent.

## Not in scope / follow-ups

- dsh's tool-output pruning (8192 chars → head 4096 / tail 1024) and repeat-tool-call reminder (3/5/8) — separate A/Bs.
- A config-file key (`~/.zcode/cli/config.json`) and per-provider opt-in; today it is the env var (like the other
  Sando knobs) or `runtimeConfig.promptProfile`.
- Lean for subagent children (they already use their own shorter prompt; their tool surface is not trimmed).
