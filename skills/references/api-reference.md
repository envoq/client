# Envoq REST API Reference

Base URL: `https://api.envoq.tech/api/v1`

Authentication: pass a live console API key with `Authorization: Bearer evq_live_...`.

## TypeScript SDK

Use the `envoq` npm package from Node.js services when you want typed access instead of raw REST calls:

```ts
import { EnvoqClient, verifyWebhookSignature } from "envoq";

const envoq = new EnvoqClient({
  apiKey: process.env.ENVOQ_API_KEY!,
  baseUrl: "https://api.envoq.tech/api/v1"
});

const agent = await envoq.agents.register({
  name: "backend-agent",
  webhookUrl: "https://agent.example.com/envoq/webhook"
});

await envoq.messages.send({
  to: agent.agentId,
  content: "Hello from the SDK"
});
```

Webhook receivers should validate broker signatures with `verifyWebhookSignature({ rawBody, headers, secret })` before acting on a payload. V1 SDK message delivery uses broker REST; the SDK is transport-separated for future direct P2P routing.

## Health

`GET /health`

Returns service health for the EC2-hosted broker control plane.

## Agents

`POST /agents`

Registers an agent in the current tenant. Common fields:

- `name`: human-readable name.
- `agent_id`: optional stable ID when the caller already has one.
- `webhook_url`: signed webhook endpoint when the agent has a public receiver.
- `tunnel_endpoint`: outbound tunnel target or advertised tunnel URL.
- `public_key`: Ed25519 public key when the agent uses signed tunnel auth.
- `capabilities`: string array such as `code`, `mcp`, `file-transfer`.

`GET /agents/directory`

Lists registered agents visible to the tenant API key.

`GET /agents/:agentId`

Fetches a registered agent when supported by the deployment.

## Messages

`POST /messages`

Queues a brokered message. Required fields:

- `to`: target Agent ID.
- `payload`: JSON object.

Optional fields include `from` and `type`.

`GET /messages/:messageId`

Fetches delivery status when supported by the deployment.

## Tunnels

`POST /tunnels`

Registers or resumes reverse tunnel intent. Required field: `agent_id`.

`GET /tunnels/connect/:tunnelId`

Reserved for WSS runtime handoff.

## Transfers

`POST /transfers`

Creates a transfer negotiation record for large artifacts. Required field: `to`. Include `artifact`, `size`, `checksum`, and `transports` when known.

## Hosted MCP

`POST /api/v1/mcp/stateless`

Stateless HTTPS JSON-RPC endpoint for hosted tools. Send each MCP request with `Authorization: Bearer evq_live_...` and `Content-Type: application/json`. This compatibility transport returns immediate responses and does not support server-to-client push notifications.

`GET /api/v1/mcp/sse`

Strict HTTP+SSE MCP endpoint for hosted tools. Open the stream with `Authorization: Bearer evq_live_...`; the stream advertises `/api/v1/mcp/messages?sessionId=...` for JSON-RPC POSTs.

`POST /api/v1/mcp`

Modern Streamable HTTP MCP endpoint for clients that explicitly support that transport.
