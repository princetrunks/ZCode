// Sando lean-local prompt profile: which provider base URLs count as a self-hosted (local) endpoint.
// Run: pnpm test in apps/zcode-cli/packages/adapters (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalEndpoint } from "../src/model/local-endpoint.ts";

test("loopback, private-network and local hostnames are local", () => {
  for (const url of [
    "http://127.0.0.1:8100/v1",
    "http://127.3.4.5/v1",
    "http://localhost:11434/v1",
    "http://api.localhost/v1",
    "http://10.0.0.7:8080/v1",
    "http://172.16.0.1/v1",
    "http://172.31.255.255/v1",
    "http://192.168.1.20:8000/v1",
    "http://100.64.1.2/v1",
    "http://169.254.10.10/v1",
    "http://0.0.0.0:8100/v1",
    "http://[::1]:8100/v1",
    "http://[fd12:3456::1]/v1",
    "http://[fe80::1]/v1",
    "http://[::ffff:192.168.1.5]/v1",
    "http://phoenix.local:8100/v1",
    "http://gpu-box.lan/v1",
    "http://llm.internal/v1",
    "http://box.home.arpa/v1",
  ]) {
    assert.equal(isLocalEndpoint(url), true, url);
  }
});

test("public hosts, look-alikes and bad input are not local", () => {
  for (const url of [
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://api.deepseek.com",
    "http://172.32.0.1/v1",
    "http://172.15.0.1/v1",
    "http://192.169.1.1/v1",
    "http://100.128.0.1/v1",
    "http://8.8.8.8/v1",
    "http://[2001:db8::1]/v1",
    "http://[::ffff:8.8.8.8]/v1",
    "http://127.0.0.1.example.com/v1",
    "http://localhost.example.com/v1",
    "http://local/v1",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(isLocalEndpoint(url), false, String(url));
  }
});
