import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { timingSafeEqual } from 'crypto';
import type { SidecarStore, TransferRecord } from './store.ts';

export interface SidecarFileServerOptions {
    host?: string;
    port?: number;
    publicUrl?: string;
}

export interface SidecarFileServerStatus {
    running: boolean;
    public_url?: string;
    host?: string;
    port?: number;
}

function tokenFromRequest(request: IncomingMessage, url: URL): string | null {
    const header = request.headers['x-envoq-transfer-token'];
    if (typeof header === 'string' && header.length > 0) {
        return header;
    }
    if (Array.isArray(header) && typeof header[0] === 'string' && header[0].length > 0) {
        return header[0];
    }
    return url.searchParams.get('token');
}

function timingSafeStringEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
}

function getExpectedToken(record: TransferRecord): string | null {
    const token = record.manifest.metadata?.access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(body));
    response.writeHead(statusCode, {
        'content-type': 'application/json',
        'content-length': payload.length
    });
    response.end(payload);
}

export function buildTransferFileUrl(publicUrl: string, transferId: string, token: string): string {
    const url = new URL(`/transfers/${encodeURIComponent(transferId)}`, publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`);
    url.searchParams.set('token', token);
    return url.toString();
}

export class SidecarFileServer {
    private server: http.Server | null = null;
    private publicUrl: string | null = null;
    private host: string | null = null;
    private port: number | null = null;
    private readonly store: SidecarStore;

    constructor(store: SidecarStore) {
        this.store = store;
    }

    get status(): SidecarFileServerStatus {
        if (!this.server || !this.publicUrl || !this.host || this.port === null) {
            return { running: false };
        }
        return {
            running: true,
            public_url: this.publicUrl,
            host: this.host,
            port: this.port
        };
    }

    getPublicUrl(): string | null {
        return this.publicUrl;
    }

    async start(options: SidecarFileServerOptions = {}): Promise<SidecarFileServerStatus> {
        if (this.server) {
            return this.status;
        }

        const host = options.host ?? process.env.ENVOQ_SIDECAR_FILE_HOST ?? '127.0.0.1';
        const port = options.port ?? Number.parseInt(process.env.ENVOQ_SIDECAR_FILE_PORT ?? '0', 10);
        const server = http.createServer((request, response) => {
            void this.handleRequest(request, response);
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.off('error', reject);
                resolve();
            });
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('Unable to determine sidecar file server address');
        }

        this.server = server;
        this.host = host;
        this.port = address.port;
        const publicHost = host === '0.0.0.0' ? '127.0.0.1' : host;
        this.publicUrl = (options.publicUrl ?? process.env.ENVOQ_SIDECAR_PUBLIC_URL ?? `http://${publicHost}:${address.port}`).replace(/\/+$/, '');
        return this.status;
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        this.server = null;
        this.publicUrl = null;
        this.host = null;
        this.port = null;
    }

    private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            if (request.method !== 'GET') {
                sendJson(response, 405, { error: 'method_not_allowed' });
                return;
            }

            const url = new URL(request.url ?? '/', 'http://sidecar.local');
            const match = /^\/transfers\/([^/]+)$/.exec(url.pathname);
            if (!match) {
                sendJson(response, 404, { error: 'not_found' });
                return;
            }

            const transferId = decodeURIComponent(match[1] ?? '');
            const record = await this.store.getTransfer(transferId);
            if (!record || record.role !== 'sender' || !record.local_path) {
                sendJson(response, 404, { error: 'transfer_not_found' });
                return;
            }

            const expectedToken = getExpectedToken(record);
            const providedToken = tokenFromRequest(request, url);
            if (!expectedToken || !providedToken || !timingSafeStringEqual(providedToken, expectedToken)) {
                sendJson(response, 401, { error: 'unauthorized' });
                return;
            }

            const fileStats = await stat(record.local_path);
            if (!fileStats.isFile()) {
                sendJson(response, 410, { error: 'artifact_unavailable' });
                return;
            }

            response.writeHead(200, {
                'content-type': record.manifest.content_type,
                'content-length': fileStats.size,
                'x-envoq-transfer-id': record.transfer_id,
                'x-envoq-sha256': record.manifest.sha256
            });

            const stream = createReadStream(record.local_path);
            stream.on('error', () => {
                response.destroy();
            });
            stream.pipe(response);
        } catch (error: any) {
            if (!response.headersSent) {
                sendJson(response, 500, { error: 'file_server_error', message: error?.message ?? 'unknown error' });
            } else {
                response.destroy(error);
            }
        }
    }
}
