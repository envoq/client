import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
    EnvoqAPIError,
    EnvoqClient,
    verifyWebhookSignature,
    type MessageSendResult
} from '../src/sdk/index.ts';

const API_KEY = 'evq_live_test_sdk_key';

interface CapturedRequest {
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body: Record<string, unknown>;
}

async function createFixture(t: TestContext): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
    const requests: CapturedRequest[] = [];

    const server = createServer((req, res) => {
        void handleRequest(req, res, requests);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((err) => err ? reject(err) : resolve());
        });
    });

    const address = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
        requests
    };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, requests: CapturedRequest[]): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJsonBody(req);
    requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        headers: req.headers,
        body
    });

    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        writeJson(res, 401, { error: { code: 'unauthorized', message: 'Missing or invalid API key' } });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/agents') {
        const agent = agentRecord({
            agent_id: String(body.agent_id ?? 'agt_generated'),
            name: String(body.name ?? 'Generated Agent'),
            webhook_url: typeof body.webhook_url === 'string' ? body.webhook_url : null,
            capabilities: Array.isArray(body.capabilities) ? body.capabilities : []
        });
        writeJson(res, 201, {
            agent_id: agent.agent_id,
            agent,
            status: 'registered',
            security_policy: { policy_id: 'envoq-payload-safety-v1' }
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/agents/directory') {
        writeJson(res, 200, {
            agents: [agentRecord()],
            directory_scope: 'tenant'
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/agents/agt_123') {
        writeJson(res, 200, { agent: agentRecord() });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/agents/missing') {
        writeJson(res, 404, { error: { code: 'not_found', message: 'Unknown agent' } });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/messages') {
        writeJson(res, 202, {
            message_id: 'msg_123',
            status: 'queued',
            message: {
                message_id: 'msg_123',
                sender_agent_id: body.from ?? null,
                recipient_agent_id: body.to,
                event_type: body.type ?? 'message',
                payload: body.payload,
                status: 'queued',
                delivery_mode: 'control-plane',
                created_at: '2026-06-30T00:00:00.000Z',
                updated_at: '2026-06-30T00:00:00.000Z'
            }
        });
        return;
    }

    writeJson(res, 404, { error: { code: 'not_found', message: 'Unknown route' } });
}

function agentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        agent_id: 'agt_123',
        name: 'Test Agent',
        webhook_url: 'https://agent.example.com/envoq/webhook',
        tunnel_endpoint: null,
        public_key: 'pub_test',
        capabilities: ['code'],
        metadata: { region: 'test' },
        status: 'online',
        last_seen: '2026-06-30T00:00:00.000Z',
        created_at: '2026-06-30T00:00:00.000Z',
        updated_at: '2026-06-30T00:00:00.000Z',
        ...overrides
    };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

test('EnvoqClient registers, lists, and gets agents with Bearer auth', async (t) => {
    const { baseUrl, requests } = await createFixture(t);
    const envoq = new EnvoqClient({ apiKey: API_KEY, baseUrl: `${baseUrl}/` });

    const registration = await envoq.agents.register({
        name: 'Generated Agent',
        webhookUrl: 'https://agent.example.com/envoq/webhook',
        capabilities: ['code'],
        metadata: { tier: 'test' }
    });
    assert.equal(registration.agentId, 'agt_generated');
    assert.equal(registration.agent.webhookUrl, 'https://agent.example.com/envoq/webhook');
    assert.equal(registration.status, 'registered');

    const agents = await envoq.agents.list();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.agentId, 'agt_123');

    const agent = await envoq.agents.get('agt_123');
    assert.equal(agent.name, 'Test Agent');
    assert.deepEqual(agent.capabilities, ['code']);

    const registerRequest = requests.find((request) => request.method === 'POST' && request.path === '/api/v1/agents');
    assert.equal(registerRequest?.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(registerRequest?.body.webhook_url, 'https://agent.example.com/envoq/webhook');
    assert.deepEqual(registerRequest?.body.capabilities, ['code']);
});

test('messages.send maps string content and JSON payloads onto broker messages', async (t) => {
    const { baseUrl, requests } = await createFixture(t);
    const envoq = new EnvoqClient({ apiKey: API_KEY, baseUrl });

    const contentResult = await envoq.messages.send({
        to: 'agt_123',
        from: 'agt_sender',
        content: 'Hello from the SDK'
    });
    assert.equal(contentResult.messageId, 'msg_123');
    assert.equal(contentResult.message.recipientAgentId, 'agt_123');
    assert.deepEqual(contentResult.message.payload, { content: 'Hello from the SDK' });

    await envoq.messages.send({
        to: 'agt_123',
        type: 'task.requested',
        payload: { task: 'analyze' }
    });

    const messageRequests = requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/messages');
    assert.deepEqual(messageRequests[0]?.body.payload, { content: 'Hello from the SDK' });
    assert.deepEqual(messageRequests[1]?.body.payload, { task: 'analyze' });
    assert.equal(messageRequests[1]?.body.type, 'task.requested');
});

test('messages.send supports an injected transport for future direct delivery', async () => {
    let receivedTo = '';
    const expected: MessageSendResult = {
        messageId: 'msg_direct',
        status: 'queued',
        message: {
            messageId: 'msg_direct',
            senderAgentId: null,
            recipientAgentId: 'agt_direct',
            eventType: 'message',
            payload: { content: 'direct-ready' },
            status: 'queued',
            deliveryMode: 'direct-p2p',
            createdAt: '',
            updatedAt: ''
        }
    };

    const envoq = new EnvoqClient({
        apiKey: API_KEY,
        messageTransport: {
            async send(input) {
                receivedTo = input.to;
                return expected;
            }
        }
    });

    const result = await envoq.messages.send({ to: 'agt_direct', content: 'direct-ready' });
    assert.equal(receivedTo, 'agt_direct');
    assert.equal(result.message.deliveryMode, 'direct-p2p');
});

test('EnvoqClient raises typed API errors for non-2xx responses', async (t) => {
    const { baseUrl } = await createFixture(t);
    const envoq = new EnvoqClient({ apiKey: API_KEY, baseUrl });

    await assert.rejects(
        () => envoq.agents.get('missing'),
        (error) => {
            assert.ok(error instanceof EnvoqAPIError);
            assert.equal(error.status, 404);
            assert.equal(error.code, 'not_found');
            assert.equal(error.message, 'Unknown agent');
            return true;
        }
    );
});

test('verifyWebhookSignature validates Envoq HMAC webhook headers', () => {
    const secret = 'webhook_secret';
    const rawBody = JSON.stringify({ message: 'hello' });
    const timestamp = Date.now().toString();
    const nonce = 'nonce-123';
    const signature = createHmac('sha256', secret)
        .update(timestamp)
        .update(nonce)
        .update(rawBody)
        .digest('hex');

    assert.equal(verifyWebhookSignature({
        rawBody,
        headers: {
            'X-Envoq-Signature': signature,
            'X-Envoq-Timestamp': timestamp,
            'X-Envoq-Nonce': nonce
        },
        secret
    }), true);

    assert.equal(verifyWebhookSignature({
        rawBody,
        headers: {
            'x-envoq-signature': 'bad',
            'x-envoq-timestamp': timestamp,
            'x-envoq-nonce': nonce
        },
        secret
    }), false);

    assert.equal(verifyWebhookSignature({
        rawBody,
        headers: {
            'x-envoq-signature': signature,
            'x-envoq-timestamp': String(Date.now() - 600_000),
            'x-envoq-nonce': nonce
        },
        secret
    }), false);
});
