import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { SidecarInbox } from '../src/sidecar/inbox.ts';
import { EnvoqTunnelClient } from '../src/sidecar/tunnel-client.ts';
import { FrameType, formatFrame, parseFrame } from '../src/sidecar/tunnel-frame.ts';

const agentId = 'a2a:agent:default:test-tunnel';
const tenantId = 'tenant_test';
const apiKey = 'evq_live_test';

function publicKeyFromRawBase64(publicKey: string): crypto.KeyObject {
    return crypto.createPublicKey({
        key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: Buffer.from(publicKey, 'base64').toString('base64url')
        },
        format: 'jwk'
    });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function waitFor<T>(fn: () => T | undefined | null | Promise<T | undefined | null>, timeoutMs = 2_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for condition');
}

test('EnvoqTunnelClient registers identity, opens signed WSS tunnel, and stores incoming messages', async (t) => {
    let registeredPublicKey = '';
    let registeredAgentId = '';
    const receivedFrames: ReturnType<typeof parseFrame>[] = [];

    const server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/api/v1/agents') {
            assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
            const body = await readJsonBody(req);
            registeredAgentId = String(body.agent_id);
            registeredPublicKey = String(body.public_key);
            assert.equal(registeredAgentId, agentId);
            assert.ok(registeredPublicKey.length > 0);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                tenant_id: tenantId,
                agent_id: agentId,
                agent: {
                    agent_id: agentId,
                    public_key: registeredPublicKey,
                    status: 'registered'
                }
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        assert.equal(req.url, '/api/v1/connect');
        assert.equal(req.headers['x-envoq-agent-id'], agentId);
        assert.equal(req.headers['x-envoq-tenant-id'], tenantId);
        const timestamp = String(req.headers['x-envoq-timestamp']);
        const signature = String(req.headers['x-envoq-signature']);
        assert.ok(timestamp.length > 0);
        assert.ok(signature.length > 0);
        const verified = crypto.verify(
            null,
            Buffer.from(`${agentId}.${timestamp}`),
            publicKeyFromRawBase64(registeredPublicKey),
            Buffer.from(signature, 'hex')
        );
        assert.equal(verified, true);
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    let serverWs: WebSocket | null = null;
    wss.on('connection', (ws) => {
        serverWs = ws;
        ws.on('message', (data) => {
            if (Buffer.isBuffer(data)) {
                receivedFrames.push(parseFrame(data));
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Missing test server address');
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'envoq-tunnel-client-'));
    const inbox = new SidecarInbox(path.join(dir, 'inbox.json'));
    const client = new EnvoqTunnelClient({
        hubUrl: `http://127.0.0.1:${address.port}/api/v1`,
        apiKey,
        agentId,
        identityPath: path.join(dir, 'identity.json'),
        pingIntervalMs: 10_000,
        onMessage: async (message) => await inbox.append(message)
    });

    t.after(() => {
        client.stop();
        wss.close();
        server.close();
    });

    await client.start();
    const ws = await waitFor(() => serverWs);

    ws.send(formatFrame(42, FrameType.PING, Buffer.alloc(0)));
    await waitFor(() => receivedFrames.find((frame) => frame.frameType === FrameType.PONG));

    ws.send(formatFrame(99, FrameType.SYN, Buffer.from(JSON.stringify({
        hub_message_id: 'msg_test_1',
        sender_id: 'a2a:agent:default:sender',
        payload: { content: 'hello over tunnel' }
    }))));

    const stored = await waitFor(async () => {
        const messages = await inbox.list({ includeAcknowledged: true });
        return messages[0];
    });
    assert.equal(stored.hub_message_id, 'msg_test_1');
    assert.deepEqual(stored.payload, { content: 'hello over tunnel' });
    await waitFor(() => receivedFrames.find((frame) => frame.frameType === FrameType.DATA && frame.streamId === 99));
    await waitFor(() => receivedFrames.find((frame) => frame.frameType === FrameType.FIN && frame.streamId === 99));

    const status = client.status();
    assert.equal(status.connected, true);
    assert.equal(status.tenant_id, tenantId);
});

test('EnvoqTunnelClient falls back to default tenant for legacy broker registration responses', async (t) => {
    const originalTenantId = process.env.ENVOQ_TENANT_ID;
    delete process.env.ENVOQ_TENANT_ID;

    let registeredAgentId = '';
    let upgradeTenantId = '';

    const server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/api/v1/agents') {
            assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
            const body = await readJsonBody(req);
            registeredAgentId = String(body.agent_id);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                agent_id: registeredAgentId,
                agent: {
                    agent_id: registeredAgentId,
                    status: 'registered'
                }
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        assert.equal(req.url, '/api/v1/connect');
        assert.equal(req.headers['x-envoq-agent-id'], agentId);
        upgradeTenantId = String(req.headers['x-envoq-tenant-id']);
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Missing test server address');
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'envoq-tunnel-client-legacy-'));
    const client = new EnvoqTunnelClient({
        hubUrl: `http://127.0.0.1:${address.port}/api/v1`,
        apiKey,
        agentId,
        identityPath: path.join(dir, 'identity.json'),
        pingIntervalMs: 10_000
    });

    t.after(() => {
        if (originalTenantId === undefined) {
            delete process.env.ENVOQ_TENANT_ID;
        } else {
            process.env.ENVOQ_TENANT_ID = originalTenantId;
        }
        client.stop();
        wss.close();
        server.close();
    });

    await client.start();

    assert.equal(registeredAgentId, agentId);
    assert.equal(upgradeTenantId, 'default');
    const status = client.status();
    assert.equal(status.connected, true);
    assert.equal(status.tenant_id, 'default');
});

test('EnvoqTunnelClient times out a stalled WebSocket handshake', async (t) => {
    const sockets: Socket[] = [];

    const server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/api/v1/agents') {
            const body = await readJsonBody(req);
            assert.equal(String(body.agent_id), agentId);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                tenant_id: tenantId,
                agent_id: agentId
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    server.on('upgrade', (_req, socket) => {
        sockets.push(socket);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Missing test server address');
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'envoq-tunnel-client-timeout-'));
    const client = new EnvoqTunnelClient({
        hubUrl: `http://127.0.0.1:${address.port}/api/v1`,
        apiKey,
        agentId,
        identityPath: path.join(dir, 'identity.json'),
        connectTimeoutMs: 50,
        reconnectMinMs: 10_000,
        reconnectMaxMs: 10_000
    });

    t.after(() => {
        client.stop();
        for (const socket of sockets) {
            socket.destroy();
        }
        server.close();
    });

    const startedAt = Date.now();
    await assert.rejects(
        () => client.start(),
        /WebSocket connection timed out after 50ms/
    );

    assert.equal(client.status().connected, false);
    assert.match(client.status().last_error ?? '', /timed out after 50ms/);
    assert.ok(Date.now() - startedAt < 1_000);
});

async function testRestrictedHandshake(statusCode: 402 | 403, statusText: string): Promise<void> {
    const body = `${statusText} tunnel access`;
    const server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/api/v1/agents') {
            const requestBody = await readJsonBody(req);
            assert.equal(String(requestBody.agent_id), agentId);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                tenant_id: tenantId,
                agent_id: agentId
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    server.on('upgrade', (_req, socket) => {
        socket.write([
            `HTTP/1.1 ${statusCode} ${statusText}`,
            'Content-Type: text/plain',
            `Content-Length: ${Buffer.byteLength(body)}`,
            '',
            body
        ].join('\r\n'));
        socket.destroy();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Missing test server address');
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), `envoq-tunnel-client-${statusCode}-`));
    const client = new EnvoqTunnelClient({
        hubUrl: `http://127.0.0.1:${address.port}/api/v1`,
        apiKey,
        agentId,
        identityPath: path.join(dir, 'identity.json'),
        restrictedReconnectMinMs: 60_000,
        restrictedReconnectMaxMs: 120_000
    });

    try {
        await assert.rejects(
            () => client.start(),
            new RegExp(`HTTP ${statusCode}`)
        );

        const status = client.status();
        assert.equal(status.connected, false);
        assert.equal(status.last_http_status, statusCode);
        assert.equal(status.last_failure_kind, 'restricted');
        assert.equal(status.reconnect_attempts, 1);
        assert.ok(status.next_reconnect_at);
        const nextReconnectIn = Date.parse(status.next_reconnect_at) - Date.now();
        assert.ok(nextReconnectIn > 30_000);
    } finally {
        client.stop();
        server.close();
    }
}

test('EnvoqTunnelClient uses slow backoff for 402 tunnel handshake rejection', async () => {
    await testRestrictedHandshake(402, 'Payment Required');
});

test('EnvoqTunnelClient uses slow backoff for 403 tunnel handshake rejection', async () => {
    await testRestrictedHandshake(403, 'Forbidden');
});
