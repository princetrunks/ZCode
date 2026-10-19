// Same scripted 2-turn session through two Sando builds; dump every request body (messages+params) per build.
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
const [, , cliA, cliB, modelId] = process.argv;
const bodies = [];
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    if (req.method !== "POST") { res.writeHead(200, {"content-type":"application/json"}); return res.end('{"data":[]}'); }
    const j = JSON.parse(b); bodies.push(j);
    const msgs = j.messages; const last = msgs.at(-1);
    const turn = JSON.stringify(msgs).match(/TURN[12]/g)?.at(-1);
    const tools = (j.tools||[]).map(t=>t.function.name);
    const call = last.role !== "tool" && tools.includes("Read");
    res.writeHead(200, {"content-type":"text/event-stream"});
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const ch = (delta, fin=null) => ({id:"c", object:"chat.completion.chunk", model:j.model, choices:[{index:0, delta, finish_reason:fin}]});
    send(ch({role:"assistant"})); send(ch({reasoning_content: `${turn}-${call?"plan":"final"}`}));
    if (call) { send(ch({tool_calls:[{index:0,id:`t${bodies.length}`,type:"function",function:{name:"Read",arguments:'{"file_path":"README.md"}'}}]})); send(ch({},"tool_calls")); }
    else { send(ch({content:`done ${turn}`})); send(ch({},"stop")); }
    send({id:"c",object:"chat.completion.chunk",model:j.model,choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
async function run(cli, tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-")); const home = path.join(base, "home"); const ws = path.join("/tmp", "cmp-ws-fixed");
  fs.rmSync(ws, {recursive:true, force:true}); fs.mkdirSync(ws, {recursive:true}); fs.writeFileSync(path.join(ws,"README.md"),"# tiny\n");
  fs.mkdirSync(path.join(home,".zcode","v2"),{recursive:true});
  const mc = {enabled:true,properties:{contextWindow:131072,supportsJsonSchemaOutput:false,supportsNativeWebSearch:false,supportsMidConversationSystem:false,inputFormat:{supportsImage:false,supportsVideo:false,supportsPdf:false}},optionSpecs:{reasoningLevel:{values:["disabled","enabled"],map:"{}"},maxOutputTokens:{max:8192}}};
  fs.writeFileSync(path.join(home,".zcode","v2","provider_config.json"), JSON.stringify({schemaVersion:1,config:{providerOrder:["p"],providerConfigRules:{providerRules:[{providerId:"p",enabled:true,config:{group:"standard-personal",access:{type:"api-key",apiKey:"x"},api:{type:"openai-chat-completions",baseUrl:`http://127.0.0.1:${port}/v1`},personalModelIds:[modelId],modelOrder:[modelId]}}]},modelConfigRules:{providerModelRules:[],manualProviderModelRules:[{providerId:"p",modelId,config:mc}]},defaultModelSelection:{providerId:"p",modelId}}}));
  const sh = (args) => new Promise((resolve) => { const c = spawn(process.execPath, [cli, ...args], {cwd: ws, env: {...process.env, HOME: home}}); let o=""; c.stdout.on("data",(d)=>o+=d); c.on("close",()=>resolve(o)); });
  const start = bodies.length;
  const o1 = JSON.parse(await sh(["-p","TURN1 read the readme","--model",`p/${modelId}`,"--json"]));
  await sh(["--resume", o1.sessionId, "-p","TURN2 again","--model",`p/${modelId}`,"--json"]);
  const norm = (s) => s.replace(/sess_[A-Za-z0-9_-]+/g,"SESS").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{27,}/g,"UUID").replaceAll(base,"BASE").replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g,"TS").replace(/toolu?_[A-Za-z0-9]+|call_[A-Za-z0-9]+/g,"CALLID").replace(/"t\d+"/g,"\"TID\"");
  return bodies.slice(start).map((b) => norm(JSON.stringify(b)));
}
const a = await run(cliA, "A"); const b = await run(cliB, "B");
console.log(`requests A=${a.length} B=${b.length}`);
let same = a.length === b.length;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) { console.log(`#${i} identical (${a[i].length} bytes)`); continue; }
  same = false;
  let k = 0; while (a[i]?.[k] === b[i]?.[k]) k++;
  console.log(`#${i} DIFFER at ${k}: A=…${a[i]?.slice(Math.max(0,k-80), k+120)}\n   B=…${b[i]?.slice(Math.max(0,k-80), k+120)}`);
}
console.log(same ? "ALL IDENTICAL" : "DIFFERENT");
server.close();
