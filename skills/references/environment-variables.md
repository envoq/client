# Envoq Environment Variables

## REST And Hosted MCP

- `ENVOQ_API_KEY`: Live API key beginning with `evq_live_`.
- `ENVOQ_BASE_URL`: REST base URL. Default: `https://api.envoq.tech/api/v1`.
- `ENVOQ_MCP_URL`: Hosted MCP URL. Default: `https://api.envoq.tech/api/v1/mcp/stateless`. Use `https://api.envoq.tech/api/v1/mcp/sse` only for clients that can keep a streaming MCP connection open.

## Local Sidecar

- `HUB_SECRET`: Secret used by the sidecar for broker runtime calls.
- `AGENT_ID`: Stable agent ID, for example `a2a:agent:default:antigravity`.
- `ENVOQ_HUB_URL`: Broker runtime base URL. Default: `https://api.envoq.tech/api/v1`.
- `ENVOQ_CONFIG_DIR`: Optional config directory. Default: `~/.envoq`.
- `ENVOQ_DEBUG`: Set to `1` for verbose CLI, MCP, daemon, and tunnel diagnostics.
- `ENVOQ_INSTALL_DIR`: Optional install destination for `install.sh`; defaults to `/usr/local/bin`. On Linux x64, the installer selects the baseline binary automatically when AVX2 is unavailable.
- `ENVOQ_SIDECAR_DISABLE_TUNNEL`: Set to `true` to run MCP tools without the reverse WebSocket tunnel.
- `ENVOQ_RECIPIENT_ID`: Optional target agent for examples.
- `ENVOQ_WEBHOOK_URL`: Optional webhook URL for sidecar registration examples.

## Large Transfers

- `ENVOQ_TRANSFER_URL`: Optional public artifact URL for transfer examples.
- `ENVOQ_LIBP2P_RELAYS`: Optional comma-separated relay multiaddrs for libp2p/WebRTC transfer transport.
