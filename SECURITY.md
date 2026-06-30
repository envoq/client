# Security Policy

## Payload Safety Boundary

Envoq authenticates transport envelopes and routes opaque payloads. It does not inspect, scan, approve, or guarantee the safety of payload contents, external URLs, downloaded files, scripts, archives, media, documents, or other artifacts referenced by agents.

Receiving agents must treat every payload field and external reference as untrusted input, even when the Envoq HMAC signature is valid. A valid Envoq signature proves the delivery envelope was authenticated; it does not prove that the inner payload is safe.

## Required Agent Controls

Agents receiving Envoq-delivered webhooks must:

1. Verify `x-envoq-signature`, `x-envoq-timestamp`, and `x-envoq-nonce` before processing the delivery envelope.
2. Reject external artifacts unless the sender provides a `sha256` or stronger checksum and the downloaded bytes match it.
3. Download and parse files only inside a sandbox with no ambient credentials, minimal filesystem access, and constrained network access.
4. Apply scheme, host, content-type, and size allowlists before fetching external resources.
5. Avoid executing, importing, rendering, or unsafe-deserializing payload content without validation and isolation.

The TypeScript SDK exposes `verifyWebhookSignature({ rawBody, headers, secret })` to make the first control easy to apply in Node.js webhook receivers.

## Local Sidecar And Large Transfers

The Envoq Sidecar keeps outbound broker connectivity for local agents and helps negotiate large artifact transfers without sending heavy bytes through the broker.

Senders should prefer the sender-hosted model: keep the file locally, publish only a lightweight manifest, and let the receiver fetch from a direct peer or agent-hosted endpoint. The Sidecar advertises libp2p/WebRTC multiaddrs first when that transport is running. The authenticated local HTTP file server remains a fallback for LAN, VPN, reverse-proxy, and public-host cases.

Receivers should use the Sidecar download path, which tries libp2p/WebRTC before HTTP, stores artifacts in an isolated sandbox directory, and marks a transfer delivered only after byte count and SHA-256 checksum verification succeeds.

External cloud storage is a last-resort fallback after SLA expiry or planned shutdown. Agents must enforce cooldowns and attempt limits to avoid upload loops. When moving back from cloud storage to sender-hosted transfer, the sender must publish a newer manifest revision before revoking or deleting the cloud object.

## Reporting Vulnerabilities

Do not open public issues for security vulnerabilities. Report security issues to `security@envoq.tech`.
