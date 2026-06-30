import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { LargeTransferManifest } from './manifest.ts';

export type TransferStatus =
    | 'drafted'
    | 'sla_proposed'
    | 'sla_accepted'
    | 'sender_hosted'
    | 'receiver_fetching'
    | 'delivered'
    | 'fallback_pending'
    | 'cloud_hosted'
    | 'evicting_cloud'
    | 'expired'
    | 'failed';

export interface TransferHistoryEntry {
    at: string;
    event: string;
    status: TransferStatus;
    revision: number;
    detail?: Record<string, unknown>;
}

export interface TransferRecord {
    transfer_id: string;
    role: 'sender' | 'receiver';
    status: TransferStatus;
    manifest: LargeTransferManifest;
    local_path?: string;
    last_published_stream_id?: string;
    fallback_attempts: number;
    history: TransferHistoryEntry[];
}

interface TransferStateFile {
    transfers: Record<string, TransferRecord>;
}

function defaultStatePath(): string {
    return process.env.ENVOQ_SIDECAR_STATE_PATH
        || path.join(process.cwd(), '.envoq_sidecar', 'transfers.json');
}

function historyEntry(
    record: Pick<TransferRecord, 'status' | 'manifest'>,
    event: string,
    detail?: Record<string, unknown>,
    now: Date = new Date()
): TransferHistoryEntry {
    const entry: TransferHistoryEntry = {
        at: now.toISOString(),
        event,
        status: record.status,
        revision: record.manifest.revision
    };
    if (detail) {
        entry.detail = detail;
    }
    return entry;
}

export class SidecarStore {
    public readonly statePath: string;

    constructor(statePath: string = defaultStatePath()) {
        this.statePath = statePath;
    }

    async listTransfers(): Promise<TransferRecord[]> {
        const state = await this.readState();
        return Object.values(state.transfers);
    }

    async getTransfer(transferId: string): Promise<TransferRecord | null> {
        const state = await this.readState();
        return state.transfers[transferId] ?? null;
    }

    async saveTransfer(record: TransferRecord, event: string = 'saved'): Promise<TransferRecord> {
        const state = await this.readState();
        const existing = state.transfers[record.transfer_id];
        if (existing && record.manifest.revision < existing.manifest.revision) {
            throw new Error(`Refusing stale manifest revision ${record.manifest.revision}; latest is ${existing.manifest.revision}`);
        }

        const nextRecord: TransferRecord = {
            ...record,
            history: [
                ...record.history,
                historyEntry(record, event)
            ]
        };
        state.transfers[record.transfer_id] = nextRecord;
        await this.writeState(state);
        return nextRecord;
    }

    async updateTransfer(
        transferId: string,
        updater: (record: TransferRecord) => TransferRecord,
        event: string
    ): Promise<TransferRecord> {
        const state = await this.readState();
        const existing = state.transfers[transferId];
        if (!existing) {
            throw new Error(`Transfer not found: ${transferId}`);
        }

        const updated = updater(existing);
        if (updated.transfer_id !== transferId || updated.manifest.transfer_id !== transferId) {
            throw new Error('Transfer updater cannot change transfer_id');
        }
        if (updated.manifest.revision < existing.manifest.revision) {
            throw new Error(`Refusing stale manifest revision ${updated.manifest.revision}; latest is ${existing.manifest.revision}`);
        }

        const nextRecord: TransferRecord = {
            ...updated,
            history: [
                ...updated.history,
                historyEntry(updated, event)
            ]
        };
        state.transfers[transferId] = nextRecord;
        await this.writeState(state);
        return nextRecord;
    }

    private async readState(): Promise<TransferStateFile> {
        try {
            const raw = await readFile(this.statePath, 'utf8');
            const parsed = JSON.parse(raw) as TransferStateFile;
            return {
                transfers: parsed.transfers ?? {}
            };
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                return { transfers: {} };
            }
            throw err;
        }
    }

    private async writeState(state: TransferStateFile): Promise<void> {
        await mkdir(path.dirname(this.statePath), { recursive: true });
        const tmpPath = `${this.statePath}.${process.pid}.tmp`;
        await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await rename(tmpPath, this.statePath);
    }
}

export function createTransferRecord(params: {
    role: 'sender' | 'receiver';
    status: TransferStatus;
    manifest: LargeTransferManifest;
    localPath?: string;
    fallbackAttempts?: number;
    event?: string;
}): TransferRecord {
    const record: TransferRecord = {
        transfer_id: params.manifest.transfer_id,
        role: params.role,
        status: params.status,
        manifest: params.manifest,
        fallback_attempts: params.fallbackAttempts ?? 0,
        history: []
    };

    if (params.localPath) {
        record.local_path = params.localPath;
    }

    record.history.push(historyEntry(record, params.event ?? 'created'));
    return record;
}
