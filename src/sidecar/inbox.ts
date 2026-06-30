import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface IncomingTunnelMessageInput {
    streamId: number;
    hubMessageId?: string | undefined;
    senderId?: string | undefined;
    payload: unknown;
    raw: string;
}

export interface SidecarInboxMessage {
    id: string;
    stream_id: number;
    hub_message_id?: string | undefined;
    sender_id?: string | undefined;
    payload: unknown;
    raw: string;
    received_at: string;
    acknowledged_at?: string | undefined;
}

interface InboxState {
    messages: SidecarInboxMessage[];
}

function defaultInboxPath(): string {
    return process.env.ENVOQ_SIDECAR_INBOX_PATH
        || path.join(process.cwd(), '.envoq_sidecar', 'inbox.json');
}

function messageId(input: IncomingTunnelMessageInput, receivedAt: string): string {
    const stable = input.hubMessageId && input.hubMessageId.length > 0
        ? input.hubMessageId
        : `${input.streamId}:${receivedAt}`;
    return stable.replace(/[^a-zA-Z0-9:._-]+/g, '_');
}

export class SidecarInbox {
    public readonly path: string;

    constructor(inboxPath: string = defaultInboxPath()) {
        this.path = inboxPath;
    }

    async append(input: IncomingTunnelMessageInput): Promise<SidecarInboxMessage> {
        const state = await this.readState();
        const receivedAt = new Date().toISOString();
        const id = messageId(input, receivedAt);
        const existing = state.messages.find((message) => message.id === id);
        if (existing) {
            return existing;
        }
        const message: SidecarInboxMessage = {
            id,
            stream_id: input.streamId,
            payload: input.payload,
            raw: input.raw,
            received_at: receivedAt
        };
        if (input.hubMessageId !== undefined) {
            message.hub_message_id = input.hubMessageId;
        }
        if (input.senderId !== undefined) {
            message.sender_id = input.senderId;
        }
        state.messages.push(message);
        await this.writeState(state);
        return message;
    }

    async list(options: { includeAcknowledged?: boolean; limit?: number } = {}): Promise<SidecarInboxMessage[]> {
        const state = await this.readState();
        const messages = options.includeAcknowledged === true
            ? state.messages
            : state.messages.filter((message) => !message.acknowledged_at);
        const sorted = [...messages].sort((a, b) => b.received_at.localeCompare(a.received_at));
        if (typeof options.limit === 'number' && Number.isSafeInteger(options.limit) && options.limit > 0) {
            return sorted.slice(0, options.limit);
        }
        return sorted;
    }

    async read(id: string): Promise<SidecarInboxMessage | null> {
        const state = await this.readState();
        return state.messages.find((message) => message.id === id) ?? null;
    }

    async ack(id: string): Promise<SidecarInboxMessage | null> {
        const state = await this.readState();
        const message = state.messages.find((entry) => entry.id === id);
        if (!message) {
            return null;
        }
        message.acknowledged_at = message.acknowledged_at ?? new Date().toISOString();
        await this.writeState(state);
        return message;
    }

    async counts(): Promise<{ total: number; unread: number; acknowledged: number }> {
        const state = await this.readState();
        const acknowledged = state.messages.filter((message) => Boolean(message.acknowledged_at)).length;
        return {
            total: state.messages.length,
            unread: state.messages.length - acknowledged,
            acknowledged
        };
    }

    private async readState(): Promise<InboxState> {
        try {
            const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<InboxState>;
            return {
                messages: Array.isArray(parsed.messages) ? parsed.messages : []
            };
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                return { messages: [] };
            }
            throw err;
        }
    }

    private async writeState(state: InboxState): Promise<void> {
        await mkdir(path.dirname(this.path), { recursive: true });
        const tmpPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await rename(tmpPath, this.path);
    }
}
