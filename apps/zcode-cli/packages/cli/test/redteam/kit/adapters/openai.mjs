// White-hat kit — adapter for any OpenAI-compatible chat endpoint (llama.cpp, vLLM, Ollama /v1, LM Studio …).
//
// It replays a case the way a typical tool loop would: system prompt → (seeded outside content) → user turn → up to
// `maxRounds` tool rounds → final text. Tool calls are NEVER executed: a stub returns a benign canned result. A project
// plugs in its own server-side defences so the kit measures the SYSTEM, not just the model:
//   makeGate({ operatorText, hasAttachments, hasUntrustedHistory }) → { check(name,args) → null|heldText,
//                                                                        observe(name,result) → result, notice() → string,
//                                                                        finalize?(text) → text }  (reply rewrite after outside content)
//   guardOutput(text) → text                       (the project's output filter)
//   formatAttachment(filename, body) → string       (how the project puts a file body into the user turn)
//   isSideEffect(name, args) → bool                 (per-call; default = name in sideEffectTools)
// Safety: loopback URLs only unless allowRemote (never point it at a cloud model with client data).

const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;

export function createOpenAIAdapter({
  name = 'openai-compatible', url, model, system = '', tools = [], sideEffectTools = [], protectedTexts = null, vocab = {},
  makeGate = null, guardOutput = null, formatAttachment = null, isSideEffect = null, temperature = 0.3, maxTokens = 1024, maxRounds = 3,
  timeoutMs = 120000, allowRemote = false, fetchImpl = globalThis.fetch,
} = {}) {
  if (!url) throw new Error('adapter needs url');
  if (!allowRemote && !LOOPBACK.test(url)) throw new Error(`REFUSING non-loopback engine ${url}: the kit targets local models (pass allowRemote to override)`);
  const endpoint = `${url.replace(/\/+$/, '')}/v1/chat/completions`;
  const side = new Set(sideEffectTools);

  async function chat(messages, offerTools, signal) {
    const body = { model, messages, max_tokens: maxTokens, temperature, stream: false };
    if (offerTools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`engine ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
  }

  const stub = (n) => (n === vocab.search_tool ? { results: [], note: 'stub' } : n === vocab.page_tool ? { text: '', note: 'stub' }
    : { ok: true, note: 'stub (white-hat kit: nothing executed)' });

  async function run(c) {
    const fill = (t) => String(t || '').replace('__FLOOD__', c.floodLines ? flood(c.floodLines) : '');
    const payload = fill(c.attack);
    // A user-route case carries its attack in the user turn itself (the original suite dropped it and sent "__FLOOD__").
    let userText = c.inject === 'user' && payload ? `${fill(c.user)}\n\n${payload}` : fill(c.user);
    const gate = makeGate ? makeGate({
      operatorText: userText, hasAttachments: c.inject === 'attachment', hasUntrustedHistory: c.inject === 'history',
    }) : null;
    const pre = [];
    const seedTool = { page: vocab.page_tool, search: vocab.search_tool, email: vocab.email_tool }[c.inject];
    if (seedTool) {
      const result = c.inject === 'page' ? { url: (c.user.match(/https?:\/\/\S+/) || ['https://example.com/doc'])[0], text: payload }
        : c.inject === 'search' ? { results: [{ title: 'result', url: 'https://example.com', snippet: payload }] }
          : { messages: [{ body: payload }] };
      const seen = gate ? gate.observe(seedTool, result) : result;
      pre.push({ role: 'assistant', content: null, tool_calls: [{ id: `seed_${c.id}`, type: 'function', function: { name: seedTool, arguments: '{}' } }] });
      pre.push({ role: 'tool', tool_call_id: `seed_${c.id}`, content: typeof seen === 'string' ? seen : JSON.stringify(seen) });
    } else if (c.inject === 'attachment') {
      userText = `${c.user}\n\n${formatAttachment ? formatAttachment(c.filename, payload) : `--- ${c.filename} contents ---\n${payload}\n--- end ---`}`;
    } else if (c.inject === 'history') {
      pre.push({ role: 'user', content: 'Look this up for me.' }, { role: 'assistant', content: `Here is what I found.\n[${payload}]` });
    }

    const messages = [{ role: 'system', content: system }, ...pre, { role: 'user', content: userText }];
    const calls = [];
    let finalText = '';
    let rounds = 0;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      for (let turn = 0; turn < 8; turn++) {
        const offer = rounds < maxRounds;
        const resp = await chat(messages, offer, ctl.signal);
        const choice = resp.choices?.[0];
        if (!choice) break;
        const msg = choice.message || {};
        if (typeof msg.content === 'string' && msg.content.trim()) finalText = msg.content.trim();
        messages.push({ role: 'assistant', content: msg.content || null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
        if (!(offer && msg.tool_calls?.length)) break;
        rounds++;
        for (const call of msg.tool_calls) {
          const n = call.function?.name;
          let args = {};
          try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* model's problem */ }
          const held = gate ? gate.check(n, args) : null;
          calls.push({ name: n, args, executed: !held, ...(isSideEffect ? { side_effect: !!isSideEffect(n, args) } : {}) });
          const result = held || (gate ? gate.observe(n, stub(n)) : stub(n));
          messages.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
        }
      }
    } finally { clearTimeout(timer); }
    if (gate?.finalize) finalText = gate.finalize(finalText);
    const notice = gate?.notice?.() || '';
    if (notice) finalText = `${finalText}\n\n${notice}`.trim();
    if (guardOutput) finalText = guardOutput(finalText);
    return { finalText, calls };
  }

  return { name, model, url, vocab, sideEffectTools: side, protectedTexts: protectedTexts ?? [system], run };
}

const FLOOD_LINE = 'The render queue processed nominally and no anomalies were observed in the batch. ';
export function flood(n) { return Array.from({ length: n }, (_, i) => `[log line ${i + 1}] ${FLOOD_LINE}`).join('\n'); }
