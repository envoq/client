import axios from 'axios';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { loadOrCreateSidecarIdentity, signTunnelHandshake, type SidecarIdentity } from './identity.ts';
import { FrameType, formatFrame, parseFrame } from './tunnel-frame.ts';
import type { IncomingTunnelMessageInput } from './inbox.ts';
import { debugLog } from '../utils/debug.ts';

type TunnelFailureKind = 'network' | 'timeout' | 'http' | 'restricted';

export interface EnvoqTunnelClientConfig {
    hubUrl: string;
    apiKey: string;
    agentId: string;
    identityPath?: string;
    reconnectMinMs?: number;
    reconnectMaxMs?: number;
    pingIntervalMs?: number;
    connectTimeoutMs?: number;
    restrictedReconnectMinMs?: number;
    restrictedReconnectMaxMs?: number;
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
    last_http_status: number | null;
    last_failure_kind: TunnelFailureKind | null;
    connected_at: string | null;
    next_reconnect_at: string | null;
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

class TunnelHttpError extends Error {
    readonly httpStatus: number;
    readonly bodySnippet: string | undefined;

    constructor(status: number, statusText: string | undefined, bodySnippet?: string) {
        const label = statusText ? `${status} ${statusText}` : `${status}`;
        super(`WebSocket handshake rejected with HTTP ${label}`);
        this.name = 'TunnelHttpError';
        this.httpStatus = status;
        if (bodySnippet) {
            this.bodySnippet = bodySnippet;
        }
    }
}

function httpStatusFromError(err: unknown): number | undefined {
    if (err instanceof TunnelHttpError) {
        return err.httpStatus;
    }
    if (axios.isAxiosError(err)) {
        return err.response?.status;
    }
    const record = err && typeof err === 'object' ? err as Record<string, unknown> : {};
    return typeof record.httpStatus === 'number' ? record.httpStatus : undefined;
}

function failureKindFromError(err: unknown): TunnelFailureKind {
    const status = httpStatusFromError(err);
    if (status === 402 || status === 403) {
        return 'restricted';
    }
    if (status !== undefined) {
        return 'http';
    }
    const message = err instanceof Error ? err.message : String(err);
    return /timed out/i.test(message) ? 'timeout' : 'network';
}

function responseBodySnippet(response: IncomingMessage, limit = 2048, timeoutMs = 1_000): Promise<string> {
    return new Promise((resolve) => {
        let body = '';
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(body.trim());
        };
        const timeout = setTimeout(finish, timeoutMs);
        timeout.unref?.();

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
            if (body.length < limit) {
                body += chunk.slice(0, limit - body.length);
            }
        });
        response.on('end', finish);
        response.on('error', finish);
        response.resume();
    });
}

export class EnvoqTunnelClient {
    private readonly hubUrl: string;
    private readonly apiKey: string;
    private readonly agentId: string;
    private readonly identityPath: string | undefined;
    private readonly reconnectMinMs: number;
    private readonly reconnectMaxMs: number;
    private readonly pingIntervalMs: number;
    private readonly connectTimeoutMs: number;
    private readonly restrictedReconnectMinMs: number;
    private readonly restrictedReconnectMaxMs: number;
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
    private lastHttpStatus: number | null = null;
    private lastFailureKind: TunnelFailureKind | null = null;
    private nextReconnectAt: string | null = null;
    private connectPromise: Promise<void> | null = null;

    constructor(config: EnvoqTunnelClientConfig) {
        this.hubUrl = config.hubUrl.replace(/\/+$/, '');
        this.apiKey = config.apiKey;
        this.agentId = config.agentId;
        this.identityPath = config.identityPath;
        this.reconnectMinMs = config.reconnectMinMs ?? 1_000;
        this.reconnectMaxMs = config.reconnectMaxMs ?? 30_000;
        this.pingIntervalMs = config.pingIntervalMs ?? 30_000;
        this.connectTimeoutMs = config.connectTimeoutMs ?? 5_000;
        this.restrictedReconnectMinMs = config.restrictedReconnectMinMs ?? 15 * 60_000;
        this.restrictedReconnectMaxMs = config.restrictedReconnectMaxMs ?? 60 * 60_000;
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

    async refreshNow(): Promise<void> {
        this.shouldRun = true;
        this.clearReconnectTimer();
        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
            try {
                this.ws.terminate();
            } catch {
                // The socket may already be closed.
            }
            this.ws = null;
        }
        if (!this.connectPromise) {
            this.connectPromise = this.connectOnce().finally(() => {
                this.connectPromise = null;
            });
        }
        await this.connectPromise;
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
            last_http_status: this.lastHttpStatus,
            last_failure_kind: this.lastFailureKind,
            connected_at: this.connectedAt,
            next_reconnect_at: this.nextReconnectAt
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
            this.lastHttpStatus = httpStatusFromError(err) ?? null;
            this.lastFailureKind = failureKindFromError(err);
            debugLog('Reverse tunnel connection failed', {
                kind: this.lastFailureKind,
                http_status: this.lastHttpStatus,
                message: this.lastError
            });
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
            ?? this.tenantId
            ?? 'default';
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

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                const err = new Error(`WebSocket connection timed out after ${this.connectTimeoutMs}ms`);
                this.lastError = err.message;
                ws.terminate();
                reject(err);
            }, this.connectTimeoutMs);
            timeout.unref?.();

            ws.on('open', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                this.state = 'connected';
                this.connectedAt = new Date().toISOString();
                this.lastError = null;
                this.lastHttpStatus = null;
                this.lastFailureKind = null;
                this.nextReconnectAt = null;
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

            ws.on('close', (code, reason) => {
                this.stopPingLoop();
                this.connectedAt = null;
                if (this.ws === ws) {
                    this.ws = null;
                }
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    const detail = reason.length > 0
                        ? `: ${reason.toString('utf8')}`
                        : code > 0
                            ? ` with code ${code}`
                            : '';
                    reject(new Error(`WebSocket closed before connection opened${detail}`));
                }
                if (this.shouldRun) {
                    this.scheduleReconnect();
                } else {
                    this.state = 'stopped';
                }
            });

            ws.on('unexpected-response', (_request, response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                const status = response.statusCode ?? 0;
                const statusText = response.statusMessage;
                const bodyPromise = responseBodySnippet(response);
                const rejectWithError = (bodySnippet?: string) => {
                    const err = new TunnelHttpError(status, statusText, bodySnippet);
                    this.lastError = bodySnippet
                        ? `${err.message}: ${bodySnippet}`
                        : err.message;
                    this.lastHttpStatus = status;
                    this.lastFailureKind = failureKindFromError(err);
                    debugLog('Reverse tunnel handshake rejected', {
                        http_status: status,
                        status_text: statusText,
                        body: bodySnippet
                    });
                    ws.terminate();
                    reject(err);
                };
                bodyPromise.then(rejectWithError, () => rejectWithError());
            });

            ws.on('error', (err) => {
                this.lastError = err.message;
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
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
        const restricted = this.lastFailureKind === 'restricted';
        const minDelay = restricted ? this.restrictedReconnectMinMs : this.reconnectMinMs;
        const maxDelay = restricted ? this.restrictedReconnectMaxMs : this.reconnectMaxMs;
        const exponent = restricted
            ? Math.min(this.reconnectAttempts - 1, 2)
            : Math.min(this.reconnectAttempts - 1, 6);
        const delay = Math.min(maxDelay, minDelay * 2 ** exponent);
        this.nextReconnectAt = new Date(Date.now() + delay).toISOString();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.nextReconnectAt = null;
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
        this.nextReconnectAt = null;
    }
}
