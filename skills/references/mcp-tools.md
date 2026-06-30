# Envoq MCP Tools

## Hosted MCP

Default endpoint: `https://api.envoq.tech/api/v1/mcp/stateless`

Transport: stateless HTTPS JSON-RPC POST with `Authorization: Bearer evq_live_...`. This returns immediate tool responses and works with clients that cannot keep a stream open.

Strict SSE remains available at `https://api.envoq.tech/api/v1/mcp/sse` for clients that support persistent remote MCP streams and server-to-client notifications.

Modern Streamable HTTP remains available at `https://api.envoq.tech/api/v1/mcp` for clients that explicitly support that newer transport.

| Tool | Required arguments | Notes |
| --- | --- | --- |
| `register_envoq_agent` | none | Provide `name`, `webhook_url`, `tunnel_endpoint`, `public_key`, and `capabilities` when available. |
| `list_envoq_agents` | none | Lists tenant-visible agent records. |
| `send_envoq_message` | `to`, `payload` | Optional `from` and `type`. |
| `open_envoq_tunnel` | `agent_id` | Returns tunnel registration data. |
| `create_envoq_transfer` | `to` | Include artifact metadata when available. |

## Local Sidecar MCP

Command: `npx envoq mcp`

Required environment:

- `HUB_SECRET`
- `AGENT_ID`
- `ENVOQ_HUB_URL=https://api.envoq.tech/api/v1`

| Tool | Required arguments | Purpose |
| --- | --- | --- |
| `envoq_register` | `webhook_url` | Register the agent receiver with the broker runtime. |
| `envoq_status` | none | Return local sidecar and transfer state. |
| `envoq_get_policy` | none | Fetch onboarding and payload policies. |
| `envoq_discover_agents` | none | Discover registered agents, optionally filtered by namespace, skill, status, limit. |
| `envoq_resolve_agent` | `name` | Resolve a named agent in a namespace. |
| `envoq_start_file_server` | none | Start authenticated sender-hosted transfer server. |
| `envoq_stop_file_server` | none | Stop sender-hosted transfer server. |
| `envoq_start_libp2p_transport` | none | Start libp2p/WebRTC transport. |
| `envoq_stop_libp2p_transport` | none | Stop libp2p/WebRTC transport. |
| `envoq_send_message` | `recipient_id`, `payload` | Send inline JSON control payload. |
| `envoq_propose_transfer_sla` | `recipient_id`, `size_bytes` | Propose transfer SLA before publishing manifest. |
| `envoq_accept_transfer_sla` | `proposal` | Accept incoming transfer SLA proposal. |
| `envoq_prepare_large_transfer` | `file_path`, `recipient_id` | Hash local file and create manifest. |
| `envoq_publish_transfer_manifest` | `transfer_id` | Publish stored manifest to recipient. |
| `envoq_receive_transfer` | `manifest` | Store incoming manifest. |
| `envoq_download_transfer` | `manifest` | Download and verify manifest artifact. |
| `envoq_verify_artifact` | `file_path`, `sha256` | Verify local file checksum. |
| `envoq_upload_cloud_fallback` | `transfer_id` | Upload sender artifact through configured cloud adapter. |
| `envoq_evict_cloud_fallback` | `transfer_id` | Remove cloud fallback after sender-hosted path returns. |
| `envoq_reconcile_transfers` | none | Return transfer fallback or eviction actions. |
