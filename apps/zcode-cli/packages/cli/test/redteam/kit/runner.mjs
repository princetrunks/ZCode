#!/usr/bin/env node
// White-hat kit — runner. Library: runSuite({ adapter, cases }). CLI:
//
//   node kit/runner.mjs --adapter <module.mjs> [adapter flags] [--cases kit/cases.jsonl] [--only id1,id2] --out results.json
//   node kit/runner.mjs --url http://127.0.0.1:8099 --model lily-9b --system-file sys.txt [--tools-file tools.json]
//                       [--side-effects run_agent,create_tool] --out results.json
//
// An --adapter module default-exports `async (argv) => adapter` (see adapters/openai.mjs for the adapter shape).
// Nothing is executed: adapters stub every tool call. The runner refuses nothing itself — the adapter enforces loopback.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, summarize, loadCases, validateCases, fillCase, KIT_VERSION } from './evaluate.mjs';
import { createOpenAIAdapter } from './adapters/openai.mjs';

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function runSuite({ adapter, cases, only = null, onCase = null }) {
  const errs = validateCases(cases);
  if (errs.length) throw new Error(`bad cases:\n- ${errs.join('\n- ')}`);
  const results = [];
  for (const raw of cases) {
    if (only && !only.includes(raw.id)) continue;
    const c = fillCase(raw, adapter.vocab);
    let r;
    try {
      const out = await adapter.run(c);
      r = { id: c.id, family: c.family, ...evaluate(c, out, adapter), reply: String(out.finalText || '').slice(0, 600),
        calls: out.calls.map((k) => ({ name: k.name, executed: k.executed !== false, args: JSON.stringify(k.args).slice(0, 200) })) };
    } catch (err) { r = { id: c.id, family: c.family, verdict: 'error', reasons: [err.message] }; }
    results.push(r);
    onCase?.(r);
  }
  return { kit: KIT_VERSION, adapter: adapter.name, model: adapter.model, ran_at: new Date().toISOString(), summary: summarize(results), results };
}

export const loadKitCases = (file = path.join(KIT_DIR, 'cases.jsonl')) => loadCases(fs.readFileSync(file, 'utf8'));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = parseArgs(process.argv.slice(2));
  const adapter = args.adapter
    ? await (await import(pathToFileURL(path.resolve(args.adapter)).href)).default(args)
    : createOpenAIAdapter({
      url: args.url, model: args.model,
      system: args['system-file'] ? fs.readFileSync(args['system-file'], 'utf8') : '',
      tools: args['tools-file'] ? JSON.parse(fs.readFileSync(args['tools-file'], 'utf8')) : [],
      sideEffectTools: String(args['side-effects'] || 'run_agent,create_tool').split(',').filter(Boolean),
    });
  const run = await runSuite({
    adapter, cases: loadKitCases(args.cases), only: args.only ? String(args.only).split(',') : null,
    onCase: (r) => process.stderr.write(`· ${r.id} ${r.verdict}${r.held?.length ? ` held[${r.held}]` : ''}${r.executed?.length ? ` EXECUTED[${r.executed}]` : ''}\n`),
  });
  if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(run, null, 2)); }
  console.error(JSON.stringify(run.summary));
}
