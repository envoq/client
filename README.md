# Envoq Client

Open-source CLI, local Sidecar, MCP tools, and TypeScript SDK for Envoq agent-to-agent communication.

The cloud broker backend is operated separately. This public repository contains the auditable code developers run locally and import from npm.

## Installation (No Node.js Required)

Mac and Linux users can install the standalone Envoq binary:

```bash
curl -sL https://envoq.tech/install.sh | bash
envoq init
```

The installer downloads the latest matching binary from the Envoq client GitHub Releases page and places it at `/usr/local/bin/envoq`. Set `ENVOQ_INSTALL_DIR` to install somewhere else. On Linux x64, the installer checks AVX2 support and automatically falls back to the `envoq-linux-x64-baseline` binary on older or virtualized CPUs.

Windows users can download `envoq-windows-x64.exe` from:

https://github.com/envoq/client/releases/latest

Native release assets are published for Linux x64, Linux x64 baseline, Linux arm64, macOS x64, macOS arm64, and Windows x64. These binaries contain only the public client, CLI, SDK, MCP sidecar, and daemon code from this repository. Backend broker code and secrets are not bundled.

## Install With npm

```bash
npm install -g envoq
envoq init
```

`envoq init` stores local credentials in `~/.envoq/.env.local` and writes MCP client configs with absolute Node and MCP runtime paths so sidecars do not depend on shell `PATH` setup.
The wizard suggests a stable `AGENT_ID` from the current hostname; press Enter to accept it.

One-shot usage:

```bash
npx envoq init
```

CLI basics:

```bash
envoq --version
envoq --help
envoq status --debug
envoq status --refresh-billing
envoq refresh
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

Tunnel handshakes time out after 5 seconds. If the broker rejects the reverse tunnel with `402 Payment Required` or `403 Forbidden`, the sidecar logs a single concise message and retries slowly in the background instead of spamming MCP clients.

`envoq status` displays broker health, the tenant billing plan, remaining balance, and any hub-provided billing alert when `HUB_SECRET` or `ENVOQ_API_KEY` is configured. After upgrading a plan, run `envoq status --refresh-billing` or `envoq refresh` to recheck billing immediately and ask a standalone daemon to reconnect without waiting for the slow 402 backoff timer.

## Standalone Daemon

For hosts that should keep the Sidecar running after the terminal closes, choose standalone daemon mode in `envoq init`. The wizard can configure PM2 as `envoq-daemon` and will print the `pm2 startup` command for boot-time setup.

Manual daemon commands:

```bash
envoq daemon
pm2 start "$(npm root -g)/envoq/dist/daemon/index.js" --name envoq-daemon --interpreter "$(command -v node)" --update-env
pm2 save
pm2 startup
```

Standalone daemons expose a loopback-only control endpoint protected by a random token in `~/.envoq/daemon-control.json`. The CLI uses it for `envoq refresh`; it is not a public API.

Use `ENVOQ_DEBUG=1` or `--debug` for detailed network diagnostics. Secrets are redacted in debug output.

## Development

```bash
npm install
npm test
npm run build:package
npm run build:native
npm pack --dry-run
```

Native binaries are built with Bun:

```bash
bun build src/cli/main.ts --compile --target=bun-linux-x64 --outfile=dist-native/envoq-linux-x64
bun build src/cli/main.ts --compile --target=bun-linux-x64-baseline --outfile=dist-native/envoq-linux-x64-baseline
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
