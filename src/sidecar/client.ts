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
            webhook_url: webhookUrl,
            timestamp: Date.now()
        };
        return await this.postSigned('/register', payload);
    }

    async sendMessage(recipientId: string, payload: Record<string, unknown>): Promise<string> {
        const body = {
            sender_id: this.agentId,
            recipient_id: recipientId,
            payload,
            timestamp: Date.now()
        };
        const response = await this.postSigned<{ stream_id: string }>('/message', body);
        return response.stream_id;
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
}
