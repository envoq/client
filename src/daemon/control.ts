import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { envoqConfigDir } from '../config/env.ts';
import type { EnvoqSidecar } from '../sidecar/transfers.ts';
import { debugLog } from '../utils/debug.ts';

interface ControlFile {
    host: string;
    port: number;
    token: string;
    pid: number;
    created_at: string;
}

export interface DaemonControlServer {
    readonly path: string;
    readonly port: number;
    close: () => Promise<void>;
}

function controlFilePath(): string {
    return path.join(envoqConfigDir(), 'daemon-control.json');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string {
    const header = req.headers.authorization;
    if (!header) return '';
    const value = Array.isArray(header) ? header[0] : header;
    return value?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
}

async function removeControlFile(filePath: string, token: string): Promise<void> {
    try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ControlFile>;
        if (parsed.token !== token || parsed.pid !== process.pid) {
            return;
        }
        await unlink(filePath);
    } catch {
        // Stale or missing control files are harmless.
    }
}

export async function startDaemonControlServer(sidecar: EnvoqSidecar): Promise<DaemonControlServer> {
    const host = '127.0.0.1';
    const token = randomBytes(32).toString('hex');
    const server = createServer(async (req, res) => {
        if (bearerToken(req) !== token) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
        }

        if (req.method === 'GET' && req.url === '/status') {
            sendJson(res, 200, { ok: true, status: await sidecar.status() });
            return;
        }

        if (req.method === 'POST' && req.url === '/refresh') {
            try {
                const status = await sidecar.refreshTunnel();
                sendJson(res, 202, { ok: true, tunnel: status });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                debugLog('Daemon control refresh failed', { message });
                sendJson(res, 202, { ok: false, error: message, tunnel: sidecar.tunnelStatus() });
            }
            return;
        }

        sendJson(res, 404, { error: 'not_found' });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address() as AddressInfo;
    const filePath = controlFilePath();
    const controlFile: ControlFile = {
        host,
        port: address.port,
        token,
        pid: process.pid,
        created_at: new Date().toISOString()
    };

    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(filePath), 0o700).catch(() => undefined);
    await writeFile(filePath, `${JSON.stringify(controlFile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);

    return {
        path: filePath,
        port: address.port,
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await removeControlFile(filePath, token);
        }
    };
}
