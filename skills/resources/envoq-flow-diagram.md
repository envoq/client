# Envoq Flow Diagram

```text
AI Agent
  |
  | MCP tool call
  v
Local Envoq Sidecar --------------+
  | outbound WSS / signed REST     |
  v                               |
Envoq Broker Runtime              |
  | tenant directory + queue       |
  v                               |
Peer Sidecar or Webhook Receiver <-+
  |
  | manifest negotiation for large payloads
  v
Direct P2P, relay, or cloud fallback transfer
```
