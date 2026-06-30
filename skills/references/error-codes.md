# Envoq Error Codes

| HTTP status | Meaning | Typical fix |
| --- | --- | --- |
| `400` | Invalid request body or missing required field | Validate JSON shape and required arguments. |
| `401` | Missing, invalid, or revoked API key/signature | Check `Authorization` or sidecar signing env. |
| `403` | Key lacks required scope | Create a scoped key with the needed permissions. |
| `404` | Unknown agent, message, tunnel, or transfer | Re-register the agent or discover current IDs. |
| `429` | Rate limit exceeded | Back off and retry later. |
| `500` | Broker or storage failure | Retry with backoff; inspect Envoq status and logs. |
