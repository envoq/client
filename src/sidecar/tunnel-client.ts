import axios from 'axios';
import { WebSocket } from 'ws';
import { loadOrCreateSidecarIdentity, signTunnelHandshake, type SidecarIdentity } from './identity.ts';
import { FrameType, formatFrame, parseFrame } from './tunnel-frame.ts';
import type { IncomingTunnelMessageInput } from './inbox.ts';

export interface EnvoqTunnelClientConfig {
    hubUrl: string;
    apiKey: string;
    agentId: string;
    identityPath?: string;
    reconnectMinMs?: number;
    reconnectMaxMs?: number;
    pingIntervalMs?: number;
    onMessage?: (message: IncomingTunnelMessageInput) => Promise<{ id?: string } | void>;
}

export interface EnvoqTunnelStatus {
    enabled: boolean;
    state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';
    connected: boolean;
    agent_id: string;
    tenant_id: string | null;
    wss_url: string;
    reconnect_attempts: number;
    last_error: string | null;
    connected_at: string | null;
}

interface RegistrationResponse {
    tenant_id?: string;
    tenantId?: string;
    agent?: {
        tenant_id?: string;
        tenantId?: string;
    };
}

export function tunnelConnectUrl(hubUrl: string): string {
    const url = new URL(hubUrl.replace(/\/+$/, ''));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/connect`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function maybeString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class EnvoqTunnelClient {
    private readonly hubUrl: string;
    private readonly apiKey: string;
    private readonly agentId: string;
    private readonly identityPath: string | undefined;
    private readonly reconnectMinMs: number;
    private readonly reconnectMaxMs: number;
    private readonly pingIntervalMs: number;
    private readonly onMessage: (message: IncomingTunnelMessageInput) => Promise<{ id?: string } | void>;
    private readonly wssUrl: string;

    private identity: SidecarIdentity | null = null;
    private ws: WebSocket | null = null;
    private shouldRun = false;
    private state: EnvoqTunnelStatus['state'] = 'idle';
    private tenantId: string | null = process.env.ENVOQ_TENANT_ID || null;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private awaitingPong = false;
    private connectedAt: string | null = null;
    private lastError: string | null = null;
    private connectPromise: Promise<void> | null = null;

    constructor(config: EnvoqTunnelClientConfig) {
        this.hubUrl = config.hubUrl.replace(/\/+$/, '');
        this.apiKey = config.apiKey;
        this.agentId = config.agentId;
        this.identityPath = config.identityPath;
        this.reconnectMinMs = config.reconnectMinMs ?? 1_000;
        this.reconnectMaxMs = config.reconnectMaxMs ?? 30_000;
        this.pingIntervalMs = config.pingIntervalMs ?? 30_000;
        this.onMessage = config.onMessage ?? (async () => undefined);
        this.wssUrl = tunnelConnectUrl(this.hubUrl);
    }

    async start(): Promise<void> {
        this.shouldRun = true;
        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }
        if (!this.connectPromise) {
            this.connectPromise = this.connectOnce().finally(() => {
                this.connectPromise = null;
            });
        }
        await this.connectPromise;
    }

    stop(): void {
        this.shouldRun = false;
        this.state = 'stopped';
        this.clearReconnectTimer();
        this.stopPingLoop();
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // The socket may already be closing.
            }
        }
        this.ws = null;
        this.connectedAt = null;
    }

    status(): EnvoqTunnelStatus {
        const connected = this.ws?.readyState === WebSocket.OPEN;
        return {
            enabled: this.shouldRun,
            state: connected ? 'connected' : this.state,
            connected,
            agent_id: this.agentId,
            tenant_id: this.tenantId,
            wss_url: this.wssUrl,
            reconnect_attempts: this.reconnectAttempts,
            last_error: this.lastError,
            connected_at: this.connectedAt
        };
    }

    private async connectOnce(): Promise<void> {
        this.state = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
        try {
            this.identity = await loadOrCreateSidecarIdentity(this.agentId, this.identityPath);
            await this.registerAgent(this.identity);
            await this.openWebSocket(this.identity);
        } catch (err: any) {
            this.lastError = err instanceof Error ? err.message : String(err);
            this.scheduleReconnect();
            throw err;
        }
    }

    private async registerAgent(identity: SidecarIdentity): Promise<void> {
        const response = await axios.post<RegistrationResponse>(
            `${this.hubUrl}/agents`,
            {
                agent_id: this.agentId,
                name: this.agentId,
                tunnel_endpoint: this.wssUrl,
                public_key: identity.publicKey,
                capabilities: ['mcp', 'reverse-tunnel', 'a2a-messaging'],
                metadata: {
                    runtime: 'envoq-sidecar',
                    transport: 'reverse-wss'
                }
            },
            {
                timeout: 10_000,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        const tenantId = maybeString(response.data.tenant_id)
            ?? maybeString(response.data.tenantId)
            ?? maybeString(response.data.agent?.tenant_id)
            ?? maybeString(response.data.agent?.tenantId)
            ?? this.tenantId;
        if (!tenantId) {
            throw new Error('Broker did not return tenant_id for tunnel registration');
        }
        this.tenantId = tenantId;
    }

    private async openWebSocket(identity: SidecarIdentity): Promise<void> {
        if (!this.tenantId) {
            throw new Error('Cannot open tunnel without tenant_id');
        }

        const timestamp = Date.now().toString();
        const signature = signTunnelHandshake(this.agentId, timestamp, identity.privateKey);

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(this.wssUrl, {
                headers: {
                    'X-Envoq-Agent-ID': this.agentId,
                    'X-Envoq-Tenant-ID': this.tenantId ?? '',
                    'X-Envoq-Timestamp': timestamp,
                    'X-Envoq-Signature': signature
                }
            });
            this.ws = ws;

            ws.on('open', () => {
                settled = true;
                this.state = 'connected';
                this.connectedAt = new Date().toISOString();
                this.lastError = null;
                this.reconnectAttempts = 0;
                this.startPingLoop();
                resolve();
            });

            ws.on('message', (data) => {
                void this.handleSocketMessage(data).catch((err) => {
                    this.lastError = err instanceof Error ? err.message : String(err);
                    this.sendFrame(0, FrameType.RST, Buffer.from(JSON.stringify({ error: this.lastError }))).catch(() => undefined);
                });
            });

            ws.on('pong', () => {
                this.awaitingPong = false;
            });

            ws.on('close', () => {
                this.stopPingLoop();
                this.connectedAt = null;
                if (this.ws === ws) {
                    this.ws = null;
                }
                if (this.shouldRun) {
                    this.scheduleReconnect();
                } else {
                    this.state = 'stopped';
                }
            });

            ws.on('error', (err) => {
                this.lastError = err.message;
                if (!settled) {
                    settled = true;
                    reject(err);
                    return;
                }
            });
        });
    }

    private async handleSocketMessage(data: WebSocket.RawData): Promise<void> {
        const buffer = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data);
        const frame = parseFrame(buffer);
        if (frame.frameType === FrameType.PING) {
            await this.sendFrame(frame.streamId, FrameType.PONG, Buffer.alloc(0));
            return;
        }
        if (frame.frameType !== FrameType.SYN) {
            return;
        }

        const raw = frame.payload.toString('utf8');
        let parsed: unknown = raw;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // Keep non-JSON payloads as raw text.
        }
        const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        const payload = Object.prototype.hasOwnProperty.call(record, 'payload') ? record.payload : parsed;
        const result = await this.onMessage({
            streamId: frame.streamId,
            hubMessageId: maybeString(record.hub_message_id),
            senderId: maybeString(record.sender_id),
            payload,
            raw
        });

        await this.sendFrame(frame.streamId, FrameType.DATA, Buffer.from(JSON.stringify({
            status: 202,
            accepted: true,
            inbox_id: result && typeof result.id === 'string' ? result.id : undefined
        })));
        await this.sendFrame(frame.streamId, FrameType.FIN, Buffer.alloc(0));
    }

    private async sendFrame(streamId: number, frameType: FrameType, payload: Buffer): Promise<void> {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            ws.send(formatFrame(streamId, frameType, payload), { binary: true }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    private scheduleReconnect(): void {
        if (!this.shouldRun || this.reconnectTimer) {
            return;
        }
        this.state = 'reconnecting';
        this.reconnectAttempts += 1;
        const delay = Math.min(
            this.reconnectMaxMs,
            this.reconnectMinMs * 2 ** Math.min(this.reconnectAttempts - 1, 6)
        );
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.shouldRun) {
                return;
            }
            this.connectPromise = this.connectOnce().catch(() => undefined).finally(() => {
                this.connectPromise = null;
            });
        }, delay);
    }

    private startPingLoop(): void {
        this.stopPingLoop();
        this.awaitingPong = false;
        this.pingTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                return;
            }
            if (this.awaitingPong) {
                ws.terminate();
                return;
            }
            this.awaitingPong = true;
            ws.ping();
        }, this.pingIntervalMs);
    }

    private stopPingLoop(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        this.awaitingPong = false;
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
