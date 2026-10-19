// Scripted OpenAI-compatible chat server for the Sando flag e2e test (CPU only, loopback, ephemeral port).
// scenario "loop": always call Read(README.md) while tools are offered. "confine": Read(/etc/hostname) once.
// "inside": Read(README.md) once. "text": answer at once. Each request is recorded in `requests`.
// `state.handler(req)` (subagent e2e) overrides the scenarios: it returns { calls: [{ name, args }], text, delayMs }.
// `state.inflight` / `state.peakInflight` count requests being answered at once.
import http from "node:http";

export function startFakeOpenAI() {
  const state = { scenario: "text", requests: [], handler: null, inflight: 0, peakInflight: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const j = JSON.parse(body || "{}");
      const msgs = j.messages || [];
      const text = (m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const all = msgs.map(text).join("\n") + JSON.stringify(j.tools || []);
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      const tools = (j.tools || []).map((t) => t.function?.name);
      const system = msgs.filter((m) => m.role === "system").map(text).join("\n");
      const n = state.requests.push({
        model: j.model,
        toolCount: tools.length,
        tools,
        system,
        all,
        lastTool: lastTool ? text(lastTool) : null,
      });
      let calls = [];
      let answer = `final answer from ${j.model}`;
      if (state.handler) {
        const decision = state.handler({ ...state.requests[n - 1], msgs }) ?? {};
        calls = decision.calls ?? [];
        if (decision.text !== undefined) answer = decision.text;
        state.requests[n - 1].role = decision.role;
        state.inflight += 1;
        state.peakInflight = Math.max(state.peakInflight, state.inflight);
        if (decision.delayMs) await new Promise((r) => setTimeout(r, decision.delayMs));
        state.inflight -= 1;
      } else if (tools.includes("Read")) {
        let call = null;
        if (state.scenario === "loop") call = { file_path: "README.md" };
        if (state.scenario === "confine" && !lastTool) call = { file_path: "/etc/hostname" };
        if (state.scenario === "inside" && !lastTool) call = { file_path: "README.md" };
        if (call) calls = [{ name: "Read", args: call }];
      }
      const call = calls.length > 0;
      const toolCalls = calls.map((c, i) => ({
        id: `t${n}_${i}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
      const id = `c${n}`;
      if (!j.stream) {
        const message = call
          ? { role: "assistant", content: null, tool_calls: toolCalls }
          : { role: "assistant", content: answer };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            model: j.model,
            choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const chunk = (delta, finish = null) => ({
        id,
        object: "chat.completion.chunk",
        model: j.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      send(chunk({ role: "assistant" }));
      if (call) {
        send(chunk({ tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) }));
        send(chunk({}, "tool_calls"));
      } else {
        send(chunk({ content: answer }));
        send(chunk({}, "stop"));
      }
      send({
        id,
        object: "chat.completion.chunk",
        model: j.model,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        state,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}
