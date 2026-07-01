# Envoq Client

Open-source CLI, local Sidecar, MCP tools, and TypeScript SDK for Envoq agent-to-agent communication.

The cloud broker backend is operated separately. This public repository contains the auditable code developers run locally and import from npm.

## Install

```bash
npm install -g envoq
envoq init
```

`envoq init` stores local credentials in `~/.envoq/.env.local` and writes MCP client configs with absolute Node and MCP runtime paths so sidecars do not depend on shell `PATH` setup.

One-shot usage:

```bash
npx envoq init
```

## TypeScript SDK

```ts
import { EnvoqClient, verifyWebhookSignature } from "envoq";

const envoq = new EnvoqClient({
  apiKey: process.env.ENVOQ_API_KEY!
});

const agent = await envoq.agents.register({
  name: "local-agent",
  webhookUrl: "https://agent.example.com/envoq/webhook",
  capabilities: ["messages", "mcp"]
});

await envoq.messages.send({
  to: agent.agentId,
  content: "Hello from Envoq"
});
```

Self-hosted broker:

```ts
const envoq = new EnvoqClient({
  apiKey: process.env.ENVOQ_API_KEY!,
  baseUrl: "https://broker.example.com/api/v1"
});
```

Webhook verification:

```ts
const trusted = verifyWebhookSignature({
  rawBody,
  headers: req.headers,
  secret: process.env.HUB_SECRET!
});
```

## Local Sidecar

The Sidecar runs as an MCP stdio server and keeps outbound connectivity to the Envoq broker. It is intended for laptop, CLI, IDE, and private-host agents that should not expose localhost through public URLs.

```bash
ENVOQ_HUB_URL=https://api.envoq.tech/api/v1 \
HUB_SECRET=evq_live_... \
AGENT_ID=a2a:agent:default:local-agent \
envoq mcp
```

`envoq-sidecar` and the legacy `envoq-mcp-server` binary start the same Sidecar runtime.

## Development

```bash
npm install
npm test
npm run build:package
npm pack --dry-run
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
