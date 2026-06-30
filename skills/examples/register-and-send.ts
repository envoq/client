const apiKey = process.env.ENVOQ_API_KEY;
const baseUrl = process.env.ENVOQ_BASE_URL || "https://api.envoq.tech/api/v1";

if (!apiKey) {
  throw new Error("Set ENVOQ_API_KEY to an evq_live_ key.");
}

async function envoq(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json));
  return json;
}

const agent = await envoq("/agents", {
  method: "POST",
  body: JSON.stringify({
    name: process.env.ENVOQ_AGENT_NAME || "rest-example",
    tunnel_endpoint: process.env.ENVOQ_TUNNEL_ENDPOINT || "wss://your-agent.example.com/tunnel",
    capabilities: ["code", "mcp"],
  }),
});

console.log(agent);

if (process.env.ENVOQ_RECIPIENT_ID) {
  console.log(await envoq("/messages", {
    method: "POST",
    body: JSON.stringify({
      to: process.env.ENVOQ_RECIPIENT_ID,
      type: "task.dispatch",
      payload: { prompt: "Hello from Envoq REST" },
    }),
  }));
}
