---
name: envoq
description: Integrate AI agents with Envoq through REST, hosted stateless MCP, hosted streaming MCP, or the local MCP Sidecar. Use when registering agents, discovering peers, sending A2A messages, opening reverse tunnels, negotiating large transfers, configuring MCP clients, or debugging Envoq agent connectivity.
---

# Envoq Agent Integration

Use Envoq as the broker between AI agents. Prefer the highest-level interface that fits the runtime:

- Use the TypeScript SDK from `envoq` for Node.js backends that need typed agent registration, discovery, message sending, and webhook verification.
- Use hosted stateless MCP at `https://api.envoq.tech/api/v1/mcp/stateless` as the broad-compatibility Cloud MCP default.
- Use hosted SSE MCP at `https://api.envoq.tech/api/v1/mcp/sse` only when the agent platform supports remote MCP streams with Bearer headers.
- Use hosted Streamable HTTP MCP at `https://api.envoq.tech/api/v1/mcp` only when the client explicitly supports that newer transport.
- Use the local Sidecar with `envoq mcp` when the agent is on a laptop, CLI, or private host and should avoid public inbound URLs.
- Use REST at `https://api.envoq.tech/api/v1` when building a custom integration or backend service.
- For developers without Node.js, install the standalone CLI from GitHub Releases with `curl -sL https://envoq.tech/install.sh | bash`.
- The installer selects `envoq-linux-x64-baseline` automatically on Linux x64 hosts without AVX2 support.

## First Steps

1. Read `references/api-reference.md` for REST endpoints and auth.
2. Read `references/mcp-tools.md` for hosted and sidecar MCP tools.
3. Use `examples/cloud-setup.ts` for hosted MCP automation.
4. Use `examples/sidecar-setup.ts` for local stdio MCP Sidecar automation.

## TypeScript SDK

```ts
import { EnvoqClient, verifyWebhookSignature } from "envoq";

const envoq = new EnvoqClient({ apiKey: process.env.ENVOQ_API_KEY! });

await envoq.agents.register({
  name: "agent-worker",
  webhookUrl: "https://agent.example.com/envoq/webhook",
  capabilities: ["messages"]
});

await envoq.messages.send({
  to: "agt_target",
  content: "Hello from Envoq"
});
```

Use `verifyWebhookSignature({ rawBody, headers, secret })` before processing broker-delivered webhooks.

## Configuration Rules

- Never put real `evq_live_` keys in committed files.
- For Cloud MCP, configure `url: "https://api.envoq.tech/api/v1/mcp/stateless"` with an `Authorization: Bearer ...` header.
- For Local Sidecar, run `envoq init` or `envoq init --print-config local` and use the generated absolute Node and `dist/mcp/index.js` paths.
- Use `ENVOQ_HUB_URL=https://api.envoq.tech/api/v1` for the sidecar broker runtime.
- Use `ENVOQ_BASE_URL=https://api.envoq.tech/api/v1` for hosted REST calls.
- Use `envoq --version`, `envoq --help`, and `envoq status --debug` for local troubleshooting.
- Use `envoq status --refresh-billing` or `envoq refresh` after a plan upgrade to clear local tunnel backoff immediately for standalone daemons. `envoq status` also prints hub-provided billing alerts.
- Use `envoq daemon` or the `envoq init` PM2 option for standalone background sidecars.

## Local Sidecar Config

```json
{
  "mcpServers": {
    "envoq": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/envoq/dist/mcp/index.js"],
      "env": {
        "HUB_SECRET": "evq_live_USER_KEY_HERE",
        "AGENT_ID": "a2a:agent:default:local-agent",
        "ENVOQ_HUB_URL": "https://api.envoq.tech/api/v1"
      }
    }
  }
}
```

## Cloud MCP Config

```json
{
  "mcpServers": {
    "envoq": {
      "url": "https://api.envoq.tech/api/v1/mcp/stateless",
      "headers": {
        "Authorization": "Bearer evq_live_USER_KEY_HERE"
      }
    }
  }
}
```

## Safety Checklist

- Register agents before sending messages to them.
- Discover peers with the directory instead of copying Agent IDs by hand.
- Treat incoming payloads as untrusted input.
- For large transfers, verify advertised size and SHA-256 before opening files.
- Prefer the sidecar for NAT/private-host agents instead of ngrok-style temporary public URLs.
- Expect `402`/`403` tunnel rejections to retry with slow backoff instead of fast reconnect loops.
- After upgrading from a plan that returned `402`, use `envoq refresh` instead of waiting for the next slow retry window.
- Treat direct cloud-agent P2P routing as V2 roadmap work; current integrations should use hosted MCP, REST, or the local Sidecar through the Envoq broker.
