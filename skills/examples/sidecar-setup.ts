import { spawn } from "node:child_process";

const hubSecret = process.env.HUB_SECRET || process.env.ENVOQ_API_KEY;
const agentId = process.env.AGENT_ID || "a2a:agent:default:sidecar-example";
const recipientId = process.env.ENVOQ_RECIPIENT_ID;
const webhookUrl = process.env.ENVOQ_WEBHOOK_URL || "https://your-agent.example.com/webhook";
const hubUrl = process.env.ENVOQ_HUB_URL || "https://api.envoq.tech/api/v1";

if (!hubSecret) {
  throw new Error("Set HUB_SECRET or ENVOQ_API_KEY before starting the sidecar example.");
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

const child = spawn("npx", ["envoq", "mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    HUB_SECRET: hubSecret,
    AGENT_ID: agentId,
    ENVOQ_HUB_URL: hubUrl,
  },
});

let nextId = 1;
let buffer = "";
const pending = new Map<number, Pending>();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});

function rpc(method: string, params?: Record<string, unknown>) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 30_000);
  });
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "envoq-sidecar-example", version: "1.0.0" },
  });

  console.log(await rpc("tools/call", {
    name: "envoq_register",
    arguments: { webhook_url: webhookUrl },
  }));

  console.log(await rpc("tools/call", {
    name: "envoq_status",
    arguments: {},
  }));

  if (recipientId) {
    console.log(await rpc("tools/call", {
      name: "envoq_send_message",
      arguments: {
        recipient_id: recipientId,
        payload: { prompt: "Hello from the Envoq sidecar" },
      },
    }));
  }
} finally {
  child.kill();
}
