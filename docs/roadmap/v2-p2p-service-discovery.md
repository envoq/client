# Envoq V2 Roadmap: P2P Service Discovery

## Summary

P2P Service Discovery is scheduled for Envoq V2. It is not part of the V1 launch surface.

V1 stays focused on the broker and local Sidecar model: NAT traversal, private laptop routing, broken HTTP clients, MCP compatibility, store-and-forward delivery, and reliable control-plane behavior. V2 P2P is an optimization for cloud agents that already expose public HTTPS endpoints and can safely communicate directly after resolving identity, liveness, and keys through Envoq.

In V2, Envoq should act as the control plane. Agent-to-agent HTTP can become the data plane only when both agents are public, approved, live, and cryptographically verifiable. The broker remains the durable fallback path.

## Goals

- Let public cloud agents discover each other's direct HTTPS endpoints without a human copying Agent IDs.
- Reduce broker bandwidth and latency for public cloud-to-cloud traffic.
- Preserve Envoq as the source of truth for tenant scoping, identity, approval status, public keys, capabilities, route freshness, and fallback policy.
- Keep private laptop, CLI, IDE, and NAT-bound agents on the V1 broker plus Sidecar path.

## Non-Goals For V1

- Do not make direct P2P the default delivery route.
- Do not require private laptop agents to expose public URLs.
- Do not remove store-and-forward broker delivery.
- Do not ask developers to implement registry caching, heartbeat logic, signature verification, retry policy, or fallback behavior by hand.

## Current Foundation

The existing registry already provides useful building blocks:

- Tenant and namespace-scoped agent records.
- Agent cards with names, descriptions, URLs, and skills.
- Approval status for registry filtering.
- Redis-backed hot lookup with Postgres persistence.
- `last_seen` tracking and TTL-backed Redis records.
- Batch registry reads for directory listing.

V2 should formalize these pieces into a direct-route contract instead of treating `AgentCard.url` as an implicit webhook destination.

## Proposed Data Flow

1. Agent A asks Envoq to resolve Agent B inside the same tenant or another explicitly authorized trust boundary.
2. Envoq returns a short-lived direct route descriptor only if Agent B is approved, public, live, and opted in to direct routing.
3. Agent A signs the outbound message with its Ed25519 private key.
4. Agent A sends an HTTPS POST directly to Agent B's public direct endpoint.
5. Agent B verifies Agent A's signature against Envoq's registry public key and rejects stale, replayed, unknown, offline, or unauthorized senders.
6. If direct delivery fails, times out, or cannot be verified, the client SDK falls back to the Envoq broker's store-and-forward path.

## Proposed Route Descriptor

The V2 registry should return a typed descriptor rather than asking clients to infer behavior from raw agent records:

```json
{
  "agent_id": "agt_target",
  "namespace": "default",
  "route_mode": "hybrid",
  "direct_endpoint": "https://agent.example.com/envoq/webhook",
  "status": "online",
  "capabilities": ["code", "file-transfer"],
  "public_key": "base64url-ed25519-public-key",
  "key_id": "key_2026_01",
  "algorithm": "Ed25519",
  "expires_at": "2026-06-30T12:01:00.000Z"
}
```

`route_mode` should support:

- `broker`: always use Envoq broker delivery.
- `direct`: use direct delivery only; fail closed if unavailable.
- `hybrid`: try direct delivery when safe, then fall back to broker delivery.

`hybrid` should be the V2 SDK default for public cloud agents. `broker` remains the V1 and private-agent default.

## Signed Direct Message Envelope

Direct P2P messages need an explicit envelope so Agent B can verify who sent the payload without trusting the network path:

```json
{
  "from": "agt_sender",
  "to": "agt_target",
  "message_id": "msg_01J...",
  "timestamp": "2026-06-30T12:00:05.000Z",
  "nonce": "base64url-random-nonce",
  "payload_hash": "sha256-base64url",
  "payload": {
    "type": "task.requested",
    "data": {}
  },
  "signature": "base64url-ed25519-signature",
  "key_id": "key_2026_01",
  "algorithm": "Ed25519"
}
```

Agent B should verify:

- The sender exists in the Envoq registry and is approved for the relevant tenant or trust boundary.
- The `key_id` and public key are current or still valid during a rotation grace period.
- The timestamp is inside the allowed freshness window.
- The nonce or `message_id` has not been seen before.
- The payload hash matches the received payload.
- The Ed25519 signature covers the canonical envelope fields.

## Liveness And Heartbeats

Cloud agents that opt into direct routing should heartbeat to Envoq. Suggested V2 defaults:

- Heartbeat interval: 30 seconds.
- Offline threshold: 90 seconds without heartbeat.
- Route descriptor TTL: no more than 60 seconds.
- Local SDK cache soft TTL: 30 seconds.

If a heartbeat is missed, Envoq should mark the direct route offline and clients should use broker delivery until the agent becomes live again.

## Smart SDK Resolver

Developers should not implement the routing decision tree. The SDK should own it:

```ts
await envoq.send("agt_target", payload, {
  delivery: "auto"
});
```

Recommended V2 behavior:

- `auto`: resolve route, try direct delivery only when the target is live and direct-capable, then fall back to broker delivery.
- `broker`: always use store-and-forward broker delivery.
- `direct`: use direct delivery only and fail closed if the route is unavailable or unverifiable.

The SDK should handle route caching, signature creation, HTTP timeouts, retry/backoff, route refresh, and broker fallback.

## Security Model

- Envoq remains the trust anchor for identity, approval, capabilities, keys, and route freshness.
- Direct messages use Ed25519 signatures with key IDs and rotation support.
- Agents must treat direct payloads as untrusted input even after signature verification.
- Agents must reject replayed messages using nonce or message ID storage.
- Cross-tenant direct routing should be disabled unless an explicit federation or trust policy exists.
- Broker fallback should use the existing authenticated Envoq API-key path.

## Open Implementation Questions

- Whether the direct route descriptor should be served by a new endpoint such as `GET /api/v1/agents/:id/route` or by extending the existing directory/resolve response.
- Whether heartbeats should be per agent, per route, or per active direct endpoint.
- How long public keys remain accepted during rotation.
- Whether Envoq should issue signed route descriptors so agents can validate descriptor integrity even when cached.
- Whether direct route attempts should emit audit events before fallback.

## Future Test Plan

- Resolve only approved, tenant-visible, direct-capable agents.
- Mark agents offline after missed heartbeat windows.
- Reject direct messages with invalid signatures, stale timestamps, reused nonces, wrong payload hashes, revoked keys, or unauthorized tenants.
- Fall back to broker delivery on timeout, 404, 5xx, offline route, or descriptor expiry.
- Refresh cached route descriptors after TTL expiry.
- Support key rotation without breaking active agents.
- Preserve broker-only behavior for sidecar, private laptop, CLI, and NAT-bound agents.
