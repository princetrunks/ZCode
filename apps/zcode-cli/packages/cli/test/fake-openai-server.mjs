// Scripted OpenAI-compatible chat server for the Sando flag e2e test (CPU only, loopback, ephemeral port).
// scenario "loop": always call Read(README.md) while tools are offered. "confine": Read(/etc/hostname) once.
// "inside": Read(README.md) once. "text": answer at once. Each request is recorded in `requests`.
// A function scenario gets ({ msgs, tools, lastTool }) and returns null (answer) or { name, args } (one tool call).
import http from "node:http";

export function startFakeOpenAI() {
  const state = { scenario: "text", requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
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
      const n = state.requests.push({
        model: j.model,
        toolCount: tools.length,
        all,
        lastTool: lastTool ? text(lastTool) : null,
      });
      let call = null;
      let callName = "Read";
      if (typeof state.scenario === "function") {
        const picked = state.scenario({ msgs, tools, lastTool: lastTool ? text(lastTool) : null });
        if (picked && tools.includes(picked.name)) {
          call = picked.args;
          callName = picked.name;
        }
      } else if (tools.includes("Read")) {
        if (state.scenario === "loop") call = { file_path: "README.md" };
        if (state.scenario === "confine" && !lastTool) call = { file_path: "/etc/hostname" };
        if (state.scenario === "inside" && !lastTool) call = { file_path: "README.md" };
      }
      const id = `c${n}`;
      const answer = `final answer from ${j.model}`;
      if (!j.stream) {
        const message = call
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `t${n}`,
                  type: "function",
                  function: { name: callName, arguments: JSON.stringify(call) },
                },
              ],
            }
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
        send(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `t${n}`,
                type: "function",
                function: { name: callName, arguments: JSON.stringify(call) },
              },
            ],
          }),
        );
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
