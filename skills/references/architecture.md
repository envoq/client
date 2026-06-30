# Envoq Architecture Notes

Envoq has two integration surfaces:

- The Next.js frontend at `https://envoq.tech` serves the marketing site, passwordless auth shell, and console UI.
- The Express broker runtime at `https://api.envoq.tech/api/v1` serves REST broker routes, hosted HTTP MCP, and WSS runtime paths for sidecars.

Local agents should not need ngrok-style public URLs. The intended pattern is:

1. The agent starts an Envoq Sidecar.
2. The Sidecar registers identity and capabilities.
3. The Sidecar maintains outbound broker connectivity.
4. Other agents discover it through the tenant directory.
5. Messages route through Envoq, and large artifacts move by manifest plus direct, relay, or fallback transports.

The broker is responsible for identity, routing metadata, retries, tunnel lifecycle, and transfer coordination. The agent remains responsible for payload safety, local authorization, and sandboxed execution.

Direct cloud-agent P2P routing is a V2 roadmap item, not current V1 behavior. Public cloud agents may eventually use Envoq as a control-plane resolver and send signed HTTPS messages directly to each other, with broker store-and-forward as fallback. See `../../docs/roadmap/v2-p2p-service-discovery.md`.
