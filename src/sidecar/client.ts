import axios from 'axios';
import crypto from 'crypto';
import { generateHmacSignature } from '../utils/crypto.ts';

export interface EnvoqHubClientConfig {
    hubUrl: string;
    hubSecret: string;
    agentId: string;
}

export interface DiscoverAgentsOptions {
    namespace?: string;
    skill?: string;
    status?: string;
    limit?: number;
}

export interface EnvoqBillingStatus {
    tenant_id: string;
    plan: string;
    plan_label: string;
    billing_status: string;
    status: string;
    alert: string | null;
    alert_message?: string | null;
    tunnel_allowed: boolean;
    credit_limit: number;
    current_spend: number;
    remaining_balance: number;
}

export class EnvoqHubClient {
    public readonly hubUrl: string;
    public readonly hubSecret: string;
    public readonly agentId: string;

    constructor(config: EnvoqHubClientConfig) {
        this.hubUrl = config.hubUrl.replace(/\/+$/, '');
        this.hubSecret = config.hubSecret;
        this.agentId = config.agentId;
    }

    async register(webhookUrl: string): Promise<unknown> {
        const payload = {
            agent_id: this.agentId,
            name: this.agentId,
            webhook_url: webhookUrl,
            capabilities: ['mcp', 'reverse-tunnel', 'a2a-messaging'],
            metadata: { runtime: 'envoq-sidecar' }
        };
        return await this.postBearer('/agents', payload);
    }

    async sendMessage(recipientId: string, payload: Record<string, unknown>): Promise<string> {
        const body = {
            from: this.agentId,
            to: recipientId,
            payload,
        };
        const response = await this.postBearer<{ stream_id?: string; message_id?: string }>('/messages', body);
        const id = response.stream_id ?? response.message_id;
        if (!id) {
            throw new Error('Broker did not return a message id');
        }
        return id;
    }

    async discoverAgents(options: DiscoverAgentsOptions = {}): Promise<unknown> {
        const response = await axios.get(`${this.hubUrl}/agents`, {
            params: {
                namespace: options.namespace ?? 'default',
                skill: options.skill,
                status: options.status ?? 'approved',
                limit: options.limit
            }
        });
        const data = response.data;
        if (typeof options.limit === 'number' && Number.isSafeInteger(options.limit) && options.limit > 0 && Array.isArray(data)) {
            return data.slice(0, options.limit);
        }
        return data;
    }

    async resolveAgent(name: string, namespace: string = 'default'): Promise<unknown> {
        const response = await axios.get(`${this.hubUrl}/agents/resolve`, {
            params: { name, namespace }
        });
        return {
            agent_id: `a2a:agent:${namespace}:${name}`,
            card: response.data
        };
    }

    async getBillingStatus(): Promise<EnvoqBillingStatus> {
        const response = await axios.get(`${this.hubUrl}/billing/status`, {
            headers: {
                Authorization: `Bearer ${this.hubSecret}`
            }
        });
        return response.data as EnvoqBillingStatus;
    }

    async refreshBilling(): Promise<EnvoqBillingStatus> {
        return await this.postBearer<EnvoqBillingStatus>('/billing/refresh', {});
    }

    async postSigned<T = unknown>(path: string, payload: unknown): Promise<T> {
        const timestamp = Date.now().toString();
        const nonce = crypto.randomBytes(16).toString('hex');
        const body = JSON.stringify(payload);
        const signature = generateHmacSignature(body, timestamp, nonce, this.hubSecret);
        const response = await axios.post(`${this.hubUrl}${path}`, payload, {
            headers: {
                'x-envoq-signature': signature,
                'x-envoq-timestamp': timestamp,
                'x-envoq-nonce': nonce,
                'Content-Type': 'application/json'
            }
        });
        return response.data as T;
    }

    async postBearer<T = unknown>(path: string, payload: unknown): Promise<T> {
        const response = await axios.post(`${this.hubUrl}${path}`, payload, {
            headers: {
                Authorization: `Bearer ${this.hubSecret}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data as T;
    }
}
