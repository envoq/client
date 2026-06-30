const apiKey = process.env.ENVOQ_API_KEY;
const recipientId = process.env.ENVOQ_RECIPIENT_ID;
const mcpUrl = process.env.ENVOQ_MCP_URL || "https://api.envoq.tech/api/v1/mcp/stateless";

if (!apiKey) {
  throw new Error("Set ENVOQ_API_KEY to an evq_live_ key.");
}

let nextId = 1;

async function rpc(method: string, params?: Record<string, unknown>) {
  const id = nextId++;
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP request failed: HTTP ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as {
    result?: unknown;
    error?: unknown;
  };
  if (payload.error) {
    throw new Error(JSON.stringify(payload.error));
  }
  return payload.result;
}

await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "envoq-cloud-example", version: "1.0.0" },
});

console.log(await rpc("tools/list"));

console.log(await rpc("tools/call", {
  name: "register_envoq_agent",
  arguments: {
    name: process.env.ENVOQ_AGENT_NAME || "cloud-example",
    capabilities: ["mcp", "code"],
    tunnel_endpoint: process.env.ENVOQ_TUNNEL_ENDPOINT || "wss://your-agent.example.com/tunnel",
  },
}));

if (recipientId) {
  console.log(await rpc("tools/call", {
    name: "send_envoq_message",
    arguments: {
      to: recipientId,
      type: "task.dispatch",
      payload: { prompt: "Hello from hosted Envoq MCP" },
    },
  }));
}
