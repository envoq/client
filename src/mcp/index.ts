import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { EnvoqSidecar } from "../sidecar/transfers.js";
import type { LargeTransferManifest } from "../sidecar/manifest.js";
import type { DiscoverAgentsInput, PrepareLargeTransferInput, TransferSlaProposal } from "../sidecar/transfers.js";
import { loadEnvoqEnv } from "../config/env.js";
import { debugLog } from "../utils/debug.js";

loadEnvoqEnv();

const ENVOQ_HUB_URL = process.env.ENVOQ_HUB_URL || "https://api.envoq.tech/api/v1";
const HUB_SECRET = process.env.HUB_SECRET;
const AGENT_ID = process.env.AGENT_ID;

if (!HUB_SECRET || !AGENT_ID) {
    console.error("FATAL: HUB_SECRET and AGENT_ID environment variables are required to start the Envoq MCP.");
    process.exit(1);
}

const sidecar = new EnvoqSidecar({
    hubUrl: ENVOQ_HUB_URL,
    hubSecret: HUB_SECRET,
    agentId: AGENT_ID
});

const server = new Server(
    {
        name: `envoq-mcp-sidecar-${AGENT_ID}`,
        version: "1.1.7",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

function jsonResult(data: unknown) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
}

function argsRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Missing required string argument: ${key}`);
    }
    return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number {
    const value = args[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Missing required number argument: ${key}`);
    }
    return value;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    return typeof value === "boolean" ? value : undefined;
}

function httpStatusFromError(err: unknown): number | undefined {
    const record = err && typeof err === "object" ? err as Record<string, unknown> : {};
    if (typeof record.httpStatus === "number") return record.httpStatus;
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/status(?: code)?\s+(\d{3})|HTTP\s+(\d{3})/i);
    const status = match?.[1] ?? match?.[2];
    return status ? Number(status) : undefined;
}

function tunnelStartFailureMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const status = httpStatusFromError(err);
    if (status === 402) {
        return "Reverse tunnel unavailable: HTTP 402 Payment Required. Retrying with slow backoff in the background.";
    }
    if (status === 403) {
        return "Reverse tunnel unavailable: HTTP 403 Forbidden. Retrying with slow backoff in the background.";
    }
    return `Reverse tunnel start failed; reconnect will continue in the background when possible: ${message}`;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        throw new Error(`Missing required string array argument: ${key}`);
    }
    return value as string[];
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
    const value = args[key];
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        throw new Error(`Expected string array argument: ${key}`);
    }
    return value as string[];
}

function optionalObjectArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
    const value = args[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

function manifestArg(args: Record<string, unknown>): LargeTransferManifest {
    const manifest = args.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("Missing required manifest object");
    }
    return manifest as LargeTransferManifest;
}

function slaProposalArg(args: Record<string, unknown>): TransferSlaProposal {
    const proposal = args.proposal;
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        throw new Error("Missing required proposal object");
    }
    return proposal as TransferSlaProposal;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "envoq_register",
                description: "Registers this agent's active webhook endpoint with the Envoq Hub and returns the hub onboarding policy.",
                inputSchema: {
                    type: "object",
                    properties: {
                        webhook_url: {
                            type: "string",
                            description: "The HTTPS endpoint or local reverse tunnel endpoint where this agent listens for incoming webhooks."
                        }
                    },
                    required: ["webhook_url"],
                },
            },
            {
                name: "envoq_status",
                description: "Returns sidecar status, tunnel state, inbox counts, policy source, and local large-transfer state counts.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "envoq_inbox_list",
                description: "Lists incoming Envoq messages delivered through the reverse tunnel sidecar inbox.",
                inputSchema: {
                    type: "object",
                    properties: {
                        include_acknowledged: { type: "boolean" },
                        limit: { type: "number" }
                    }
                },
            },
            {
                name: "envoq_inbox_read",
                description: "Reads one incoming Envoq sidecar inbox message by id.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string" }
                    },
                    required: ["id"],
                },
            },
            {
                name: "envoq_inbox_ack",
                description: "Acknowledges one incoming Envoq sidecar inbox message by id.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string" }
                    },
                    required: ["id"],
                },
            },
            {
                name: "envoq_get_policy",
                description: "Fetches and caches the current Envoq onboarding and large-payload policies.",
                inputSchema: {
                    type: "object",
                    properties: {
                        force_refresh: {
                            type: "boolean",
                            description: "Fetch from the hub even if the local policy cache is fresh."
                        }
                    }
                },
            },
            {
                name: "envoq_discover_agents",
                description: "Lists registered Envoq agents from the hub directory, optionally filtered by namespace, skill, or approval status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        namespace: { type: "string", description: "Agent namespace. Defaults to default." },
                        skill: { type: "string", description: "Skill id or name fragment to match." },
                        status: { type: "string", description: "Approval status to list. Use all to include pending agents." },
                        limit: { type: "number", description: "Optional maximum number of agents returned locally." }
                    }
                },
            },
            {
                name: "envoq_resolve_agent",
                description: "Resolves a registered agent card by name and namespace so callers do not need copied Agent IDs.",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        namespace: { type: "string" }
                    },
                    required: ["name"],
                },
            },
            {
                name: "envoq_start_file_server",
                description: "Starts the built-in authenticated sender-hosted file server used for large transfer fetches.",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_host: { type: "string" },
                        file_port: { type: "number" },
                        public_url: {
                            type: "string",
                            description: "Externally reachable base URL advertised in generated transfer manifests."
                        }
                    },
                },
            },
            {
                name: "envoq_stop_file_server",
                description: "Stops the built-in sender-hosted file server.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "envoq_start_libp2p_transport",
                description: "Starts the libp2p/WebRTC transfer transport for NAT-traversing large artifact delivery.",
                inputSchema: {
                    type: "object",
                    properties: {
                        listen_multiaddrs: {
                            type: "array",
                            items: { type: "string" }
                        },
                        announce_multiaddrs: {
                            type: "array",
                            items: { type: "string" }
                        },
                        bootstrap_multiaddrs: {
                            type: "array",
                            items: { type: "string" }
                        },
                        relay_multiaddrs: {
                            type: "array",
                            items: { type: "string" },
                            description: "Public libp2p relay multiaddrs used for WebRTC SDP exchange and relay reservations."
                        },
                        dial_timeout_ms: { type: "number" },
                        transfer_timeout_ms: { type: "number" },
                        chunk_bytes: { type: "number" }
                    },
                },
            },
            {
                name: "envoq_stop_libp2p_transport",
                description: "Stops the libp2p/WebRTC transfer transport.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "envoq_send_message",
                description: "Sends a JSON payload to another agent. The sidecar rejects payloads that exceed the Envoq inline size policy.",
                inputSchema: {
                    type: "object",
                    properties: {
                        recipient_id: {
                            type: "string",
                            description: "The exact AGENT_ID of the recipient."
                        },
                        payload: {
                            type: "object",
                            description: "The JSON data to send to the recipient."
                        }
                    },
                    required: ["recipient_id", "payload"],
                },
            },
            {
                name: "envoq_propose_transfer_sla",
                description: "Sends a lightweight SLA proposal before advertising a large artifact.",
                inputSchema: {
                    type: "object",
                    properties: {
                        recipient_id: { type: "string" },
                        size_bytes: { type: "number" },
                        file_name: { type: "string" },
                        sha256: { type: "string" },
                        content_type: { type: "string" },
                        sla_seconds: { type: "number" },
                        cooldown_seconds: { type: "number" }
                    },
                    required: ["recipient_id", "size_bytes"],
                },
            },
            {
                name: "envoq_accept_transfer_sla",
                description: "Accepts an incoming large-transfer SLA proposal and notifies the sender.",
                inputSchema: {
                    type: "object",
                    properties: {
                        proposal: { type: "object" }
                    },
                    required: ["proposal"],
                },
            },
            {
                name: "envoq_prepare_large_transfer",
                description: "Hashes a local file, creates a sender-hosted large-transfer manifest, and stores sidecar transfer state. If the local file server is running, the sidecar auto-adds its authenticated fetch URL.",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_path: { type: "string" },
                        recipient_id: { type: "string" },
                        transport_addresses: {
                            type: "array",
                            items: { type: "string" },
                            description: "Optional sender-hosted direct peer or HTTPS addresses where the recipient can fetch the artifact."
                        },
                        sla_seconds: { type: "number" },
                        cooldown_seconds: { type: "number" },
                        content_type: { type: "string" },
                        metadata: { type: "object" }
                    },
                    required: ["file_path", "recipient_id"],
                },
            },
            {
                name: "envoq_publish_transfer_manifest",
                description: "Publishes a stored large-transfer manifest as a lightweight Envoq message.",
                inputSchema: {
                    type: "object",
                    properties: {
                        transfer_id: { type: "string" }
                    },
                    required: ["transfer_id"],
                },
            },
            {
                name: "envoq_receive_transfer",
                description: "Accepts and stores an incoming large-transfer manifest if its revision is not stale.",
                inputSchema: {
                    type: "object",
                    properties: {
                        manifest: { type: "object" }
                    },
                    required: ["manifest"],
                },
            },
            {
                name: "envoq_download_transfer",
                description: "Accepts an incoming manifest, downloads the artifact into the sidecar sandbox, verifies size and checksum, then marks it delivered.",
                inputSchema: {
                    type: "object",
                    properties: {
                        manifest: { type: "object" },
                        sandbox_dir: { type: "string" },
                        timeout_ms: { type: "number" }
                    },
                    required: ["manifest"],
                },
            },
            {
                name: "envoq_verify_artifact",
                description: "Computes a local file sha256 and compares it with the manifest checksum before parsing.",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_path: { type: "string" },
                        sha256: { type: "string" }
                    },
                    required: ["file_path", "sha256"],
                },
            },
            {
                name: "envoq_upload_cloud_fallback",
                description: "Uploads a sender artifact through the configured cloud adapter and publishes a cloud-hosted manifest revision locally.",
                inputSchema: {
                    type: "object",
                    properties: {
                        transfer_id: { type: "string" }
                    },
                    required: ["transfer_id"],
                },
            },
            {
                name: "envoq_evict_cloud_fallback",
                description: "Restores sender-hosted responsibility with a newer manifest revision and deletes the cloud fallback object.",
                inputSchema: {
                    type: "object",
                    properties: {
                        transfer_id: { type: "string" },
                        publish_restored_manifest: { type: "boolean" }
                    },
                    required: ["transfer_id"],
                },
            },
            {
                name: "envoq_reconcile_transfers",
                description: "Reconciles local transfer state and returns required fallback or cloud-eviction actions.",
                inputSchema: {
                    type: "object",
                    properties: {
                        now: {
                            type: "string",
                            description: "Optional ISO timestamp used for deterministic reconciliation."
                        }
                    },
                },
            }
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const args = argsRecord(request.params.arguments);

        switch (request.params.name) {
            case "envoq_register": {
                return jsonResult(await sidecar.register(stringArg(args, "webhook_url")));
            }
            case "envoq_status": {
                return jsonResult(await sidecar.status());
            }
            case "envoq_inbox_list": {
                const options: { includeAcknowledged?: boolean; limit?: number } = {};
                const includeAcknowledged = optionalBooleanArg(args, "include_acknowledged");
                const limit = optionalNumberArg(args, "limit");
                if (includeAcknowledged !== undefined) {
                    options.includeAcknowledged = includeAcknowledged;
                }
                if (limit !== undefined) {
                    options.limit = limit;
                }
                return jsonResult({ messages: await sidecar.listInbox(options) });
            }
            case "envoq_inbox_read": {
                const id = stringArg(args, "id");
                const message = await sidecar.readInbox(id);
                if (!message) {
                    throw new Error(`Inbox message not found: ${id}`);
                }
                return jsonResult({ message });
            }
            case "envoq_inbox_ack": {
                const id = stringArg(args, "id");
                const message = await sidecar.ackInbox(id);
                if (!message) {
                    throw new Error(`Inbox message not found: ${id}`);
                }
                return jsonResult({ success: true, message });
            }
            case "envoq_get_policy": {
                return jsonResult(await sidecar.getPolicy(args.force_refresh === true));
            }
            case "envoq_discover_agents": {
                const input: DiscoverAgentsInput = {};
                const namespace = optionalStringArg(args, "namespace");
                const skill = optionalStringArg(args, "skill");
                const status = optionalStringArg(args, "status");
                const limit = optionalNumberArg(args, "limit");
                if (namespace !== undefined) input.namespace = namespace;
                if (skill !== undefined) input.skill = skill;
                if (status !== undefined) input.status = status;
                if (limit !== undefined) input.limit = limit;
                return jsonResult(await sidecar.discoverAgents(input));
            }
            case "envoq_resolve_agent": {
                return jsonResult(await sidecar.resolveAgent(
                    stringArg(args, "name"),
                    optionalStringArg(args, "namespace")
                ));
            }
            case "envoq_start_file_server": {
                const options: { host?: string; port?: number; publicUrl?: string } = {};
                const host = optionalStringArg(args, "file_host");
                const port = optionalNumberArg(args, "file_port");
                const publicUrl = optionalStringArg(args, "public_url");
                if (host !== undefined) {
                    options.host = host;
                }
                if (port !== undefined) {
                    options.port = port;
                }
                if (publicUrl !== undefined) {
                    options.publicUrl = publicUrl;
                }
                return jsonResult(await sidecar.startFileServer(options));
            }
            case "envoq_stop_file_server": {
                await sidecar.stopFileServer();
                return jsonResult({ success: true });
            }
            case "envoq_start_libp2p_transport": {
                const options: {
                    listen?: string[];
                    announce?: string[];
                    bootstrap?: string[];
                    relays?: string[];
                    dialTimeoutMs?: number;
                    transferTimeoutMs?: number;
                    chunkBytes?: number;
                } = {};
                const listen = optionalStringArrayArg(args, "listen_multiaddrs");
                const announce = optionalStringArrayArg(args, "announce_multiaddrs");
                const bootstrap = optionalStringArrayArg(args, "bootstrap_multiaddrs");
                const relays = optionalStringArrayArg(args, "relay_multiaddrs");
                const dialTimeoutMs = optionalNumberArg(args, "dial_timeout_ms");
                const transferTimeoutMs = optionalNumberArg(args, "transfer_timeout_ms");
                const chunkBytes = optionalNumberArg(args, "chunk_bytes");
                if (listen !== undefined) {
                    options.listen = listen;
                }
                if (announce !== undefined) {
                    options.announce = announce;
                }
                if (bootstrap !== undefined) {
                    options.bootstrap = bootstrap;
                }
                if (relays !== undefined) {
                    options.relays = relays;
                }
                if (dialTimeoutMs !== undefined) {
                    options.dialTimeoutMs = dialTimeoutMs;
                }
                if (transferTimeoutMs !== undefined) {
                    options.transferTimeoutMs = transferTimeoutMs;
                }
                if (chunkBytes !== undefined) {
                    options.chunkBytes = chunkBytes;
                }
                return jsonResult(await sidecar.startLibp2pTransport(options));
            }
            case "envoq_stop_libp2p_transport": {
                await sidecar.stopLibp2pTransport();
                return jsonResult({ success: true });
            }
            case "envoq_send_message": {
                const recipientId = stringArg(args, "recipient_id");
                const payload = optionalObjectArg(args, "payload");
                if (!payload) {
                    throw new Error("Missing required object argument: payload");
                }
                const streamId = await sidecar.sendMessage(recipientId, payload);
                return jsonResult({ success: true, stream_id: streamId });
            }
            case "envoq_propose_transfer_sla": {
                const input = {
                    recipientAgentId: stringArg(args, "recipient_id"),
                    sizeBytes: numberArg(args, "size_bytes")
                };
                const fileName = optionalStringArg(args, "file_name");
                const sha256 = optionalStringArg(args, "sha256");
                const contentType = optionalStringArg(args, "content_type");
                const slaSeconds = optionalNumberArg(args, "sla_seconds");
                const cooldownSeconds = optionalNumberArg(args, "cooldown_seconds");
                return jsonResult(await sidecar.proposeTransferSla({
                    ...input,
                    ...(fileName !== undefined ? { fileName } : {}),
                    ...(sha256 !== undefined ? { sha256 } : {}),
                    ...(contentType !== undefined ? { contentType } : {}),
                    ...(slaSeconds !== undefined ? { slaSeconds } : {}),
                    ...(cooldownSeconds !== undefined ? { cooldownSeconds } : {})
                }));
            }
            case "envoq_accept_transfer_sla": {
                return jsonResult(await sidecar.acceptTransferSla(slaProposalArg(args)));
            }
            case "envoq_prepare_large_transfer": {
                const input: PrepareLargeTransferInput = {
                    filePath: stringArg(args, "file_path"),
                    recipientAgentId: stringArg(args, "recipient_id")
                };
                const transportAddresses = optionalStringArrayArg(args, "transport_addresses");
                const slaSeconds = optionalNumberArg(args, "sla_seconds");
                const cooldownSeconds = optionalNumberArg(args, "cooldown_seconds");
                const contentType = optionalStringArg(args, "content_type");
                const metadata = optionalObjectArg(args, "metadata");
                if (transportAddresses !== undefined) {
                    input.transportAddresses = transportAddresses;
                }
                if (slaSeconds !== undefined) {
                    input.slaSeconds = slaSeconds;
                }
                if (cooldownSeconds !== undefined) {
                    input.cooldownSeconds = cooldownSeconds;
                }
                if (contentType !== undefined) {
                    input.contentType = contentType;
                }
                if (metadata !== undefined) {
                    input.metadata = metadata;
                }
                return jsonResult(await sidecar.prepareLargeTransfer(input));
            }
            case "envoq_publish_transfer_manifest": {
                return jsonResult(await sidecar.publishTransferManifest(stringArg(args, "transfer_id")));
            }
            case "envoq_receive_transfer": {
                return jsonResult(await sidecar.receiveTransferManifest(manifestArg(args)));
            }
            case "envoq_download_transfer": {
                const options: { sandboxRoot?: string; timeoutMs?: number } = {};
                const sandboxRoot = optionalStringArg(args, "sandbox_dir");
                const timeoutMs = optionalNumberArg(args, "timeout_ms");
                if (sandboxRoot !== undefined) {
                    options.sandboxRoot = sandboxRoot;
                }
                if (timeoutMs !== undefined) {
                    options.timeoutMs = timeoutMs;
                }
                return jsonResult(await sidecar.downloadTransferArtifact(manifestArg(args), options));
            }
            case "envoq_verify_artifact": {
                return jsonResult(await sidecar.verifyArtifact(
                    stringArg(args, "file_path"),
                    stringArg(args, "sha256")
                ));
            }
            case "envoq_upload_cloud_fallback": {
                return jsonResult(await sidecar.uploadCloudFallback(stringArg(args, "transfer_id")));
            }
            case "envoq_evict_cloud_fallback": {
                return jsonResult(await sidecar.evictCloudFallback(
                    stringArg(args, "transfer_id"),
                    { publishRestoredManifest: optionalBooleanArg(args, "publish_restored_manifest") === true }
                ));
            }
            case "envoq_reconcile_transfers": {
                const now = optionalStringArg(args, "now");
                return jsonResult(await sidecar.reconcileTransfers(now ? new Date(now) : new Date()));
            }
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
    } catch (error: any) {
        const errorMsg = error?.response ? JSON.stringify(error.response.data) : error.message;
        return {
            content: [{ type: "text", text: `Sidecar Error: ${errorMsg}` }],
            isError: true,
        };
    }
});

async function main() {
    if (process.env.ENVOQ_SIDECAR_AUTO_FILE_SERVER === "true") {
        const options: { host?: string; port?: number; publicUrl?: string } = {};
        if (process.env.ENVOQ_SIDECAR_FILE_HOST) {
            options.host = process.env.ENVOQ_SIDECAR_FILE_HOST;
        }
        if (process.env.ENVOQ_SIDECAR_FILE_PORT) {
            options.port = Number.parseInt(process.env.ENVOQ_SIDECAR_FILE_PORT, 10);
        }
        if (process.env.ENVOQ_SIDECAR_PUBLIC_URL) {
            options.publicUrl = process.env.ENVOQ_SIDECAR_PUBLIC_URL;
        }
        await sidecar.startFileServer(options);
    }
    if (process.env.ENVOQ_SIDECAR_AUTO_LIBP2P === "true") {
        const options: {
            listen?: string[];
            announce?: string[];
            bootstrap?: string[];
            relays?: string[];
        } = {};
        const listen = process.env.ENVOQ_LIBP2P_LISTEN?.split(",").map((entry) => entry.trim()).filter(Boolean);
        const announce = process.env.ENVOQ_LIBP2P_ANNOUNCE?.split(",").map((entry) => entry.trim()).filter(Boolean);
        const bootstrap = process.env.ENVOQ_LIBP2P_BOOTSTRAP?.split(",").map((entry) => entry.trim()).filter(Boolean);
        const relays = process.env.ENVOQ_LIBP2P_RELAYS?.split(",").map((entry) => entry.trim()).filter(Boolean);
        if (listen && listen.length > 0) {
            options.listen = listen;
        }
        if (announce && announce.length > 0) {
            options.announce = announce;
        }
        if (bootstrap && bootstrap.length > 0) {
            options.bootstrap = bootstrap;
        }
        if (relays && relays.length > 0) {
            options.relays = relays;
        }
        await sidecar.startLibp2pTransport(options);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[Envoq MCP Sidecar] Server initialized for Agent ID: ${AGENT_ID}`);
    if (process.env.ENVOQ_SIDECAR_DISABLE_TUNNEL !== "true") {
        await sidecar.startTunnel()
            .then((status) => {
                console.error(`[Envoq MCP Sidecar] Reverse tunnel connected for tenant ${status.tenant_id ?? "unknown"}`);
            })
            .catch((err) => {
                console.error(`[Envoq MCP Sidecar] ${tunnelStartFailureMessage(err)}`);
                debugLog("MCP reverse tunnel startup failure", {
                    message: err instanceof Error ? err.message : String(err),
                    http_status: httpStatusFromError(err)
                });
            });
    }
}

main().catch((err) => {
    console.error("Fatal MCP sidecar error:", err);
    process.exit(1);
});
