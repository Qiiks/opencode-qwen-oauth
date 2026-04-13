import fs from "node:fs";
import path from "node:path";

const authPath = path.join(process.env.USERPROFILE ?? "", ".local", "share", "opencode", "auth.json");
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"))["qwen-code"];
if (!auth?.access || !auth?.resourceUrl) {
  throw new Error("Missing qwen-code OAuth credentials in auth.json");
}

const base = `https://${String(auth.resourceUrl).replace(/^https?:\/\//, "").replace(/\/+$/, "")}/v1`;
const headers = {
  Authorization: `Bearer ${auth.access}`,
  "Content-Type": "application/json",
  Accept: "application/json"
};

const variants = [
  ["v1-basic", { model: "coder-model", messages: [{ role: "user", content: "ping" }] }],
  ["v2-with-max_tokens", { model: "coder-model", messages: [{ role: "user", content: "ping" }], max_tokens: 64 }],
  ["v3-with-max_completion_tokens", { model: "coder-model", messages: [{ role: "user", content: "ping" }], max_completion_tokens: 64 }],
  ["v4-content-parts", { model: "coder-model", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], max_tokens: 64 }],
  ["v5-system+user", { model: "coder-model", messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "ping" }], max_tokens: 64 }],
  ["v6-stream-true", { model: "coder-model", messages: [{ role: "user", content: "ping" }], stream: true }],
  ["v7-response_format", { model: "coder-model", messages: [{ role: "user", content: "ping" }], response_format: { type: "text" } }],
  ["v8-tools-empty", { model: "coder-model", messages: [{ role: "user", content: "ping" }], tools: [] }]
];

for (const [name, body] of variants) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await res.text();
  console.log(`${name} status=${res.status} body=${text.slice(0, 260)}`);
}
