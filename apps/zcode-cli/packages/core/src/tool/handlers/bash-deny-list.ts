/**
 * Sando: `--deny-commands <json file>` (2026-11-15). The Planner's local-only chats hand Sando the same bash deny list
 * opencode gets (agentHarness.js LOCAL_ONLY_BASH_DENY + RSYNC_REMOTE_DENY). A Bash call is refused BEFORE it runs when
 * any single command in it matches a pattern; headless runs never ask.
 *
 * Pattern semantics are opencode's (its Wildcard.match): backslashes become "/", `*` = any text, `?` = one character,
 * a trailing " *" is optional (`ssh *` also matches a bare `ssh`), the whole command must match, case-sensitive.
 *
 * Each command of a script is checked on its own: `&&`, `||`, `;`, `|`, newlines, subshells, `{ }`, if/for/while/case
 * bodies, functions, `$(…)`, backticks and `<(…)`. Every command is tried in several spellings, any match refuses:
 * the source text, the unquoted argv, the argv with `VAR=…` prefixes, the program's basename (`/usr/bin/git`),
 * `--opt=value` split, short-flag clusters split (`-sd` → `-s -d`), git's global options dropped (`git -C x push`),
 * wrappers peeled (env, sudo, timeout, nohup, xargs, …) and `sh -c` / `bash -c` / `eval` strings parsed again.
 *
 * Fails safe instead of guessing: an unparsable command, a program name that is only known at run time (`$G push`),
 * an expanded argument to a listed program (`curl $FLAGS …`), a shell reading its script from a pipe or heredoc, and
 * an unreadable or invalid deny file all refuse. Not a sandbox: an interpreter one-liner (`python -c`, `node -e`)
 * can still open a socket; the lab's guarantee remains that its engine is a forge model.
 */
import { readFileSync } from "node:fs";
import { parse } from "unbash";
import type { Command, Word, WordPart } from "unbash";

// The CLI reads the file once at startup and passes the patterns as JSON, so editing the file mid-run changes nothing.
export const DENY_COMMANDS_ENV = "SANDO_DENY_COMMANDS";

export interface DenyListMatch {
  /** The single command (as written) that was refused. */
  readonly command: string;
  /** The deny pattern it matched, or a fail-safe reason tag ("unparsable", "dynamic-name", …). */
  readonly pattern: string;
  readonly reason: string;
}

// ============================================================
// Pattern matching (opencode semantics)
// ============================================================

const compiled = new Map<string, RegExp>();

export function denyPatternToRegExp(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  const re = new RegExp(`^${source}$`, "s");
  compiled.set(pattern, re);
  return re;
}

export function matchesDenyPattern(subject: string, pattern: string): boolean {
  return denyPatternToRegExp(pattern).test(subject.replaceAll("\\", "/"));
}

// ============================================================
// Loading the list
// ============================================================

/** Parses the file body: a JSON array of strings, or `{ "deny": [...] }`. Throws on anything else. */
export function parseDenyListJson(text: string): string[] {
  const raw: unknown = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : (raw as { deny?: unknown } | null)?.deny;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('expected a non-empty JSON array of patterns or { "deny": [...] }');
  }
  for (const item of list) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`every pattern must be a non-empty string, got ${JSON.stringify(item)}`);
    }
  }
  return list as string[];
}

export function readDenyListFile(file: string): string[] {
  return parseDenyListJson(readFileSync(file, "utf8"));
}

let cache: { raw: string; patterns: string[] } | undefined;

/**
 * The active list: undefined when none is set, otherwise the patterns, or an Error when the value is set but invalid
 * (callers refuse every shell call then).
 */
export function activeDenyList(env: NodeJS.ProcessEnv = process.env): string[] | Error | undefined {
  const raw = env[DENY_COMMANDS_ENV]?.trim();
  if (!raw) return undefined;
  if (cache?.raw === raw) return cache.patterns;
  try {
    const patterns = parseDenyListJson(raw);
    cache = { raw, patterns };
    return patterns;
  } catch (error) {
    return new Error(`${DENY_COMMANDS_ENV}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================
// Checking a command line
// ============================================================

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "busybox"]);
// Programs that run their arguments as another command. Peeling them is done by trying every tail of the argv,
// so their own options and values (`timeout 5`, `nice -n 10`, `env -i A=1`) never hide the real program.
const WRAPPERS = new Set([
  "env", "command", "builtin", "exec", "sudo", "doas", "nohup", "time", "nice", "ionice", "timeout", "stdbuf",
  "setsid", "xargs", "chronic", "unbuffer", "chrt", "taskset", "flock", "caffeinate", "watch", "strace", "ltrace",
  "proxychains", "proxychains4", "torsocks", "firejail", "systemd-run", "script", "parallel", "find",
]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const MAX_DEPTH = 6;

/** Returns the first refused command, or null when every command in `commandLine` is allowed. */
export function findDeniedCommand(commandLine: string, patterns: readonly string[]): DenyListMatch | null {
  const guarded = guardedPrograms(patterns);
  return checkScript(commandLine, patterns, guarded, 0);
}

function checkScript(source: string, patterns: readonly string[], guarded: Guarded, depth: number): DenyListMatch | null {
  if (depth > MAX_DEPTH) return refuse(source, "nesting", "commands nested too deeply to check");
  if (source.trim().length === 0) return null;
  let script: ReturnType<typeof parse> & { errors?: unknown[] };
  try {
    script = parse(source);
  } catch {
    return refuse(source, "unparsable", "the shell command could not be parsed, so it cannot be checked");
  }
  if (script.errors?.length) {
    return refuse(source, "unparsable", "the shell command has syntax errors, so it cannot be checked");
  }
  const commands: Command[] = [];
  collectCommands(script, commands, new Set());
  for (const command of commands) {
    const hit = checkCommand(source, command, patterns, guarded, depth);
    if (hit) return hit;
  }
  return null;
}

/** Every `Command` node anywhere in the tree: chains, pipelines, compound bodies and nested `$(…)` scripts alike. */
function collectCommands(node: unknown, out: Command[], seen: Set<object>): void {
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) collectCommands(child, out, seen);
    return;
  }
  if ((node as { type?: unknown }).type === "Command") out.push(node as Command);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "pos" && key !== "end") collectCommands(value, out, seen);
  }
  // unbash computes Word.parts in a prototype getter, which Object.entries skips; `$(…)` scripts live under it.
  if ("parts" in node && !Object.hasOwn(node, "parts")) collectCommands((node as Word).parts, out, seen);
}

function checkCommand(
  source: string,
  command: Command,
  patterns: readonly string[],
  guarded: Guarded,
  depth: number,
): DenyListMatch | null {
  const text = source.slice(command.pos, command.end).trim();
  // A bare assignment (`A=1`) runs nothing; its `$(…)` value was already collected as its own command.
  if (!command.name) return null;

  const argv = [command.name, ...command.suffix].map(wordValue);
  const name = programName(command.name);
  if (name === undefined) {
    return refuse(text, "dynamic-name", "the program name is only known at run time (write it literally)");
  }
  argv[0] = name;

  const guard = guarded.get(name);
  if (guard !== undefined) {
    // "any": a pattern like `curl * -d*` can match on any argument; "subcommand": `git push*` only on the first one.
    const words = guard === "any" ? command.suffix : [subcommandWord(name, command.suffix)].filter(isWord);
    if (words.some(wordHasExpansion)) {
      const what = guard === "any" ? "arguments" : "the subcommand";
      return refuse(text, "dynamic-args", `${what} of ${name} must be literal here (no $VAR / $(…) expansion)`);
    }
  }

  const envText = command.prefix.map((assignment) => assignment.text).join(" ");
  const subjects = new Set<string>([text, text.replace(/\s+/g, " ")]);
  const addArgv = (words: readonly string[]) => {
    if (words.length === 0) return;
    for (const variant of argvVariants(words)) {
      const joined = variant.join(" ");
      subjects.add(joined);
      if (envText) subjects.add(`${envText} ${joined}`);
    }
  };
  addArgv(argv);
  if (name === "git") addArgv(stripGitGlobalOptions(argv));

  for (const subject of subjects) {
    const pattern = patterns.find((candidate) => matchesDenyPattern(subject, candidate));
    if (pattern) return refuse(text, pattern, `matches the deny pattern "${pattern}"`);
  }

  // Wrappers: check every tail as a command of its own (and its own wrappers / shells, recursively).
  // The tail is re-parsed from the words as written, so quoting and expansions keep their meaning.
  if (WRAPPERS.has(name)) {
    for (let index = 0; index < command.suffix.length; index += 1) {
      const tail = command.suffix.slice(index).map((word) => word.text);
      const hit = checkScript(tail.join(" "), patterns, guarded, depth + 1);
      if (hit) return { ...hit, command: text };
    }
  }

  // `sh -c "…"` / `bash -lc '…'` / `eval …`: the string is a script of its own.
  if (name === "eval") {
    if (command.suffix.some(wordHasExpansion)) return refuse(text, "dynamic-eval", "eval of an expanded string cannot be checked");
    const hit = checkScript(argv.slice(1).join(" "), patterns, guarded, depth + 1);
    if (hit) return { ...hit, command: text };
  }
  if (SHELLS.has(name)) {
    const hit = checkShellInvocation(text, command, argv, patterns, guarded, depth);
    if (hit) return hit;
  }
  return null;
}

function checkShellInvocation(
  text: string,
  command: Command,
  argv: readonly string[],
  patterns: readonly string[],
  guarded: Guarded,
  depth: number,
): DenyListMatch | null {
  let args = argv.slice(1);
  if (argv[0] === "busybox") {
    if (!SHELLS.has(args[0] ?? "")) return null;
    args = args.slice(1);
  }
  const cIndex = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
  if (cIndex >= 0) {
    // args[j] is suffix[j] (suffix[j + 1] after `busybox`), so the script after -c is one further.
    const scriptWord = command.suffix[cIndex + 1 + (argv[0] === "busybox" ? 1 : 0)];
    if (scriptWord && wordHasExpansion(scriptWord)) {
      return refuse(text, "dynamic-shell", "a shell -c script built from expansions cannot be checked");
    }
    const hit = checkScript(args[cIndex + 1] ?? "", patterns, guarded, depth + 1);
    return hit ? { ...hit, command: text } : null;
  }
  const scriptFile = args.find((arg) => !arg.startsWith("-") && !arg.startsWith("+"));
  if (scriptFile !== undefined) return null;
  if (args.some((arg) => arg === "--version" || arg === "--help")) return null;
  // No -c and no script file: the shell reads its commands from stdin. A heredoc or here-string is checked as a
  // script; a pipe or file is unknown until run time.
  const stdin = command.redirects.find((redirect) => redirect.operator.startsWith("<<"));
  const body = stdin?.operator === "<<<" ? (stdin.target ? wordValue(stdin.target) : undefined) : stdin?.content;
  if (stdin && body !== undefined) {
    const hit = checkScript(body, patterns, guarded, depth + 1);
    return hit ? { ...hit, command: text } : null;
  }
  return refuse(text, "shell-stdin", "a shell reading its commands from stdin cannot be checked (use sh -c '…')");
}

/** The program's basename, or undefined when the name itself is decided at run time. */
function programName(word: Word): string | undefined {
  const value = wordValue(word);
  if (!wordHasExpansion(word)) return basename(value);
  // `"$HOME/bin/tool"`: the basename is still literal after the last slash.
  const slash = word.text.lastIndexOf("/");
  if (slash < 0) return undefined;
  const tail = word.text.slice(slash + 1).replace(/["']/g, "");
  return tail.length > 0 && !/[$`\\*?[]/.test(tail) ? tail : undefined;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** argv as typed, plus `--opt=value` split and `-abc` short clusters split (each, and both). */
function argvVariants(argv: readonly string[]): string[][] {
  const splitEquals = argv.flatMap((arg) => {
    const match = /^(--[A-Za-z][\w-]*)=(.*)$/s.exec(arg);
    return match ? [match[1]!, match[2]!] : [arg];
  });
  const splitShort = (words: readonly string[]) =>
    words.flatMap((arg, index) =>
      index > 0 && /^-[A-Za-z]{2,}$/.test(arg) ? [...arg.slice(1)].map((flag) => `-${flag}`) : [arg],
    );
  return [[...argv], splitEquals, splitShort(argv), splitShort(splitEquals)];
}

function stripGitGlobalOptions(argv: readonly string[]): string[] {
  const out = [argv[0]!];
  let index = 1;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const arg = argv[index]!;
    if (GIT_GLOBAL_WITH_VALUE.has(arg)) index += 2;
    else index += 1;
  }
  return [...out, ...argv.slice(index)];
}

/** True for `$VAR`, `${…}`, `$(…)`, backticks, `$((…))`, `<(…)`, globs-with-commands and brace expansion. */
function wordHasExpansion(word: Word): boolean {
  return word.parts?.some(partHasExpansion) ?? false;
}

function partHasExpansion(part: WordPart): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return false;
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.some(partHasExpansion);
    default:
      return true;
  }
}

function wordValue(word: Word): string {
  return word.value ?? word.text;
}

function isWord(word: Word | undefined): word is Word {
  return word !== undefined;
}

/** The word in the subcommand position: the first non-option argument (after git's global options). */
function subcommandWord(name: string, suffix: readonly Word[]): Word | undefined {
  let index = 0;
  while (index < suffix.length && wordValue(suffix[index]!).startsWith("-")) {
    index += name === "git" && GIT_GLOBAL_WITH_VALUE.has(wordValue(suffix[index]!)) ? 2 : 1;
  }
  return suffix[index];
}

type Guarded = Map<string, "any" | "subcommand">;

/**
 * Programs named by the patterns (`*rsync *:*` → rsync), with how much of their argv must be literal: "subcommand"
 * when every pattern for the program names a literal subcommand (`git push*`, `npm publish*`), "any" otherwise.
 */
function guardedPrograms(patterns: readonly string[]): Guarded {
  const guarded: Guarded = new Map();
  for (const pattern of patterns) {
    const match = /^\**([A-Za-z0-9._+-]+)(.*)$/s.exec(pattern);
    if (!match) continue;
    const name = match[1]!;
    const kind = /^ [A-Za-z]/.test(match[2]!) ? "subcommand" : "any";
    if (guarded.get(name) !== "any") guarded.set(name, kind);
  }
  return guarded;
}

function refuse(command: string, pattern: string, reason: string): DenyListMatch {
  return { command: command.trim(), pattern, reason };
}

// ============================================================
// Tool-call entry point
// ============================================================

/** Tools that run code able to reach the network without passing through the shell checks above. */
const UNCHECKABLE_CODE_TOOLS = new Set(["js"]);

/**
 * The refusal message for a tool call, or null when it may run. Only Bash commands are matched; while a deny list is
 * active the node REPL tool (`js`) is refused outright, since it can spawn processes the shell checks never see.
 */
export function denyListRefusal(toolName: string, input: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (toolName !== "Bash" && !UNCHECKABLE_CODE_TOOLS.has(toolName)) return null;
  const list = activeDenyList(env);
  if (list === undefined) return null;
  if (list instanceof Error) {
    return `Refused (--deny-commands): ${list.message}. No shell command can run until the deny list loads.`;
  }
  if (UNCHECKABLE_CODE_TOOLS.has(toolName)) {
    return `Refused (--deny-commands): the ${toolName} tool is off in this run because its code cannot be checked against the deny list. Use Bash for commands.`;
  }
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return null;
  const hit = findDeniedCommand(command, list);
  if (!hit) return null;
  return (
    `Refused by the deny list (--deny-commands): \`${hit.command.slice(0, 300)}\` ${hit.reason}. ` +
    "This run may not send anything off the machine. Do not retry it or a variant of it; if the task needs it, say so in your summary."
  );
}
