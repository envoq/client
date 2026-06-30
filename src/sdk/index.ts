import crypto from 'node:crypto';

export const ENVOQ_DEFAULT_BASE_URL = 'https://api.envoq.tech/api/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WEBHOOK_TOLERANCE_MS = 300_000;

export type EnvoqFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EnvoqClientOptions {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetch?: EnvoqFetch;
    messageTransport?: MessageTransport;
}

export interface RegisterAgentInput {
    agentId?: string;
    name?: string;
    webhookUrl?: string;
    tunnelEndpoint?: string;
    publicKey?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
}

export interface EnvoqAgent {
    agentId: string;
    name: string;
    webhookUrl: string | null;
    tunnelEndpoint: string | null;
    publicKey: string | null;
    capabilities: unknown;
    metadata: unknown;
    status: string;
    lastSeen: string;
    createdAt: string;
    updatedAt: string;
}

export interface AgentRegistration {
    agentId: string;
    agent: EnvoqAgent;
    status: string;
    securityPolicy?: unknown;
}

export interface SendMessageInput {
    to: string;
    from?: string;
    type?: string;
    content?: string;
    payload?: Record<string, unknown>;
}

export interface EnvoqMessage {
    messageId: string;
    senderAgentId: string | null;
    recipientAgentId: string;
    eventType: string;
    payload: unknown;
    status: string;
    deliveryMode: string;
    createdAt: string;
    updatedAt: string;
}

export interface MessageSendResult {
    messageId: string;
    status: string;
    message: EnvoqMessage;
}

export interface MessageTransport {
    send(input: SendMessageInput): Promise<MessageSendResult>;
}

export interface AgentsResource {
    register(input?: RegisterAgentInput): Promise<AgentRegistration>;
    list(): Promise<EnvoqAgent[]>;
    get(agentId: string): Promise<EnvoqAgent>;
}

export interface MessagesResource {
    send(input: SendMessageInput): Promise<MessageSendResult>;
}

export interface VerifyWebhookSignatureOptions {
    rawBody: string | Buffer | Uint8Array;
    headers: Headers | Record<string, string | string[] | number | undefined>;
    secret: string;
    toleranceMs?: number;
    now?: number;
}

export class EnvoqAPIError extends Error {
    public readonly status: number;
    public readonly code: string;
    public readonly body: unknown;

    constructor(message: string, options: { status: number; code: string; body?: unknown }) {
        super(message);
        this.name = 'EnvoqAPIError';
        this.status = options.status;
        this.code = options.code;
        this.body = options.body;
    }
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

class HttpClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly fetchFn: EnvoqFetch;

    constructor(options: EnvoqClientOptions) {
        if (!options.apiKey?.trim()) {
            throw new Error('EnvoqClient requires an apiKey.');
        }

        this.apiKey = options.apiKey.trim();
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? ENVOQ_DEFAULT_BASE_URL);
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchFn = options.fetch ?? fetch;
    }

    async get<T>(path: string): Promise<T> {
        return this.request<T>('GET', path);
    }

    async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
        return this.request<T>('POST', path, body);
    }

    private async request<T>(method: HttpMethod, path: string, body?: Record<string, unknown>): Promise<T> {
        const controller = new AbortController();
        const timeout = this.timeoutMs > 0
            ? setTimeout(() => controller.abort(), this.timeoutMs)
            : undefined;

        const headers: Record<string, string> = {
            accept: 'application/json',
            authorization: `Bearer ${this.apiKey}`
        };

        const init: RequestInit = {
            method,
            headers,
            signal: controller.signal
        };

        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        try {
            const response = await this.fetchFn(joinUrl(this.baseUrl, path), init);
            return await parseResponse<T>(response);
        } catch (error) {
            if (isAbortError(error)) {
                throw new EnvoqAPIError(`Envoq request timed out after ${this.timeoutMs}ms`, {
                    status: 0,
                    code: 'timeout'
                });
            }
            throw error;
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }
}

class BrokerRestMessageTransport implements MessageTransport {
    private readonly http: HttpClient;

    constructor(http: HttpClient) {
        this.http = http;
    }

    async send(input: SendMessageInput): Promise<MessageSendResult> {
        const payload = messagePayload(input);
        const body = compact({
            to: input.to,
            from: input.from,
            type: input.type,
            payload
        });

        const response = await this.http.post<Record<string, unknown>>('/messages', body);
        return mapMessageSendResult(response);
    }
}

export class EnvoqClient {
    public readonly agents: AgentsResource;
    public readonly messages: MessagesResource;

    constructor(options: EnvoqClientOptions) {
        const http = new HttpClient(options);
        this.agents = new AgentsResourceImpl(http);
        this.messages = new MessagesResourceImpl(options.messageTransport ?? new BrokerRestMessageTransport(http));
    }
}

class AgentsResourceImpl implements AgentsResource {
    private readonly http: HttpClient;

    constructor(http: HttpClient) {
        this.http = http;
    }

    async register(input: RegisterAgentInput = {}): Promise<AgentRegistration> {
        const body = compact({
            agent_id: input.agentId,
            name: input.name,
            webhook_url: input.webhookUrl,
            tunnel_endpoint: input.tunnelEndpoint,
            public_key: input.publicKey,
            capabilities: input.capabilities,
            metadata: input.metadata
        });

        const response = await this.http.post<Record<string, unknown>>('/agents', body);
        const agent = mapAgent(asRecord(response.agent ?? response));
        return {
            agentId: stringFrom(response.agent_id) ?? agent.agentId,
            agent,
            status: stringFrom(response.status) ?? agent.status,
            securityPolicy: response.security_policy
        };
    }

    async list(): Promise<EnvoqAgent[]> {
        const response = await this.http.get<Record<string, unknown> | unknown[]>('/agents/directory');
        const agents = Array.isArray(response) ? response : asArray(asRecord(response).agents);
        return agents.map((agent) => mapAgent(asRecord(agent)));
    }

    async get(agentId: string): Promise<EnvoqAgent> {
        if (!agentId.trim()) {
            throw new Error('agents.get requires a non-empty agentId.');
        }

        const response = await this.http.get<Record<string, unknown>>(`/agents/${encodeURIComponent(agentId)}`);
        return mapAgent(asRecord(response.agent ?? response));
    }
}

class MessagesResourceImpl implements MessagesResource {
    private readonly transport: MessageTransport;

    constructor(transport: MessageTransport) {
        this.transport = transport;
    }

    async send(input: SendMessageInput): Promise<MessageSendResult> {
        if (!input.to?.trim()) {
            throw new Error('messages.send requires a target agent id in input.to.');
        }
        return this.transport.send(input);
    }
}

export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions): boolean {
    const signature = normalizeSignature(headerValue(options.headers, 'x-envoq-signature'));
    const timestamp = headerValue(options.headers, 'x-envoq-timestamp');
    const nonce = headerValue(options.headers, 'x-envoq-nonce');

    if (!signature || !timestamp || !nonce || !options.secret) {
        return false;
    }

    const parsedTimestamp = Number.parseInt(timestamp, 10);
    const toleranceMs = options.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
    const now = options.now ?? Date.now();
    if (!Number.isFinite(parsedTimestamp) || Math.abs(now - parsedTimestamp) > toleranceMs) {
        return false;
    }

    const expected = crypto
        .createHmac('sha256', options.secret)
        .update(timestamp)
        .update(nonce)
        .update(bodyBuffer(options.rawBody))
        .digest('hex');

    return timingSafeStringEqual(signature, expected);
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
    const cleanPath = path.replace(/^\/+/, '');
    return `${baseUrl}/${cleanPath}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const body = parseJson(text);

    if (!response.ok) {
        throw new EnvoqAPIError(apiErrorMessage(response.status, body), {
            status: response.status,
            code: apiErrorCode(response.status, body),
            body
        });
    }

    return body as T;
}

function parseJson(text: string): unknown {
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

function apiErrorMessage(status: number, body: unknown): string {
    const error = asRecord(body).error;
    if (typeof error === 'string') {
        return error;
    }
    const errorRecord = asRecord(error);
    return stringFrom(errorRecord.message) ?? `Envoq API request failed with status ${status}`;
}

function apiErrorCode(status: number, body: unknown): string {
    const error = asRecord(body).error;
    const errorRecord = asRecord(error);
    return stringFrom(errorRecord.code)
        ?? (status === 401 ? 'unauthorized'
            : status === 403 ? 'forbidden'
            : status === 404 ? 'not_found'
            : status === 400 ? 'invalid_request'
            : 'api_error');
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function messagePayload(input: SendMessageInput): Record<string, unknown> {
    if (input.payload) {
        return input.payload;
    }
    if (input.content !== undefined) {
        return { content: input.content };
    }
    throw new Error('messages.send requires either input.content or input.payload.');
}

function mapMessageSendResult(raw: Record<string, unknown>): MessageSendResult {
    const message = mapMessage(asRecord(raw.message));
    return {
        messageId: stringFrom(raw.message_id) ?? message.messageId,
        status: stringFrom(raw.status) ?? message.status,
        message
    };
}

function mapMessage(raw: Record<string, unknown>): EnvoqMessage {
    return {
        messageId: stringFrom(raw.message_id) ?? '',
        senderAgentId: nullableString(raw.sender_agent_id),
        recipientAgentId: stringFrom(raw.recipient_agent_id) ?? '',
        eventType: stringFrom(raw.event_type) ?? 'message',
        payload: raw.payload ?? {},
        status: stringFrom(raw.status) ?? '',
        deliveryMode: stringFrom(raw.delivery_mode) ?? '',
        createdAt: stringFrom(raw.created_at) ?? '',
        updatedAt: stringFrom(raw.updated_at) ?? ''
    };
}

function mapAgent(raw: Record<string, unknown>): EnvoqAgent {
    return {
        agentId: stringFrom(raw.agent_id) ?? '',
        name: stringFrom(raw.name) ?? '',
        webhookUrl: nullableString(raw.webhook_url),
        tunnelEndpoint: nullableString(raw.tunnel_endpoint),
        publicKey: nullableString(raw.public_key),
        capabilities: raw.capabilities ?? [],
        metadata: raw.metadata ?? {},
        status: stringFrom(raw.status) ?? '',
        lastSeen: stringFrom(raw.last_seen) ?? '',
        createdAt: stringFrom(raw.created_at) ?? '',
        updatedAt: stringFrom(raw.updated_at) ?? ''
    };
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
            output[key] = value;
        }
    }
    return output;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringFrom(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function headerValue(headers: VerifyWebhookSignatureOptions['headers'], name: string): string | undefined {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return headers.get(name) ?? undefined;
    }

    const record = headers as Record<string, string | string[] | number | undefined>;
    let value = record[name] ?? record[name.toLowerCase()];
    if (value === undefined) {
        const lowerName = name.toLowerCase();
        const matchingKey = Object.keys(record).find((key) => key.toLowerCase() === lowerName);
        value = matchingKey ? record[matchingKey] : undefined;
    }
    if (Array.isArray(value)) {
        return value[0];
    }
    if (typeof value === 'number') {
        return String(value);
    }
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeSignature(signature: string | undefined): string | undefined {
    if (!signature) {
        return undefined;
    }
    return signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
}

function bodyBuffer(rawBody: string | Buffer | Uint8Array): Buffer {
    return typeof rawBody === 'string' ? Buffer.from(rawBody) : Buffer.from(rawBody);
}

function timingSafeStringEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
