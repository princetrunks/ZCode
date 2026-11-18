#!/usr/bin/env node
// Scripted stdio MCP server for Sando e2e tests and the on-demand MCP A/B (SANDO-MCP-ONDEMAND.md). No network.
//   node fake-mcp-server.mjs <tools.json> [calls.jsonl]
// tools.json: { "tools": [MCP tool descriptors], "responses"?: { "<tool name>": <any JSON> } }.
// tools/call answers with responses[name] (or {"ok":true,"tool":name}) as JSON text, plus the arguments it got;
// a tool whose inputSchema lists `required` keys that are missing answers isError (like a real server would).
// Every tools/call is appended to calls.jsonl when given.
import fs from "node:fs";
import readline from "node:readline";

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const callsLog = process.argv[3];
const tools = spec.tools ?? [];
const responses = spec.responses ?? {};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  const { id, method, params } = request;
  if (id === undefined) return; // notification
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: spec.serverName ?? "fake-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools } });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (callsLog) fs.appendFileSync(callsLog, `${JSON.stringify({ name, args })}\n`);
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    const missing = (tool.inputSchema?.required ?? []).filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      return send({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `Missing required argument(s): ${missing.join(", ")}` }] },
      });
    }
    const body = responses[name] ?? { ok: true, tool: name };
    return send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify({ ...body, received: args }) }] },
    });
  }
  if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } });
  if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  for (const request of Array.isArray(message) ? message : [message]) handle(request);
});
