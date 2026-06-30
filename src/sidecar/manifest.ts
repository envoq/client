import crypto from 'crypto';
import fs from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { LARGE_PAYLOAD_POLICY } from '../policies/onboarding.ts';

export type LargePayloadPolicy = typeof LARGE_PAYLOAD_POLICY;
export type TransferStorageState = 'sender_hosted' | 'cloud_hosted' | 'evicting_cloud' | 'expired';

export interface LargeTransferManifest {
    transfer_id: string;
    revision: number;
    sender_agent_id: string;
    recipient_agent_id: string;
    size_bytes: number;
    sha256: string;
    content_type: string;
    storage_state: TransferStorageState;
    transport_addresses: string[];
    sla_expires_at: string;
    cooldown_until: string;
    created_at: string;
    updated_at: string;
    metadata?: Record<string, unknown>;
}

export interface CreateManifestInput {
    filePath: string;
    senderAgentId: string;
    recipientAgentId: string;
    transportAddresses?: string[];
    slaSeconds?: number;
    cooldownSeconds?: number;
    contentType?: string;
    transferId?: string;
    now?: Date;
    metadata?: Record<string, unknown>;
}

export async function hashFile(filePath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => {
            hash.update(chunk);
        });
        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });
    });
}

export function inferContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
        '.json': 'application/json',
        '.jsonl': 'application/x-ndjson',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.pdf': 'application/pdf',
        '.zip': 'application/zip',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    };
    return contentTypes[ext] ?? 'application/octet-stream';
}

export async function createLargeTransferManifest(
    input: CreateManifestInput,
    policy: LargePayloadPolicy = LARGE_PAYLOAD_POLICY
): Promise<LargeTransferManifest> {
    const fileStats = await stat(input.filePath);
    if (!fileStats.isFile()) {
        throw new Error('Large transfer path must point to a regular file');
    }

    const transportAddresses = input.transportAddresses ?? [];
    if (transportAddresses.length === 0) {
        throw new Error('At least one sender-hosted transport address is required');
    }

    const slaSeconds = input.slaSeconds ?? policy.default_sla_seconds;
    if (slaSeconds < policy.minimum_sla_seconds || slaSeconds > policy.maximum_sla_seconds) {
        throw new Error(`SLA seconds must be between ${policy.minimum_sla_seconds} and ${policy.maximum_sla_seconds}`);
    }

    const cooldownSeconds = input.cooldownSeconds ?? slaSeconds;
    if (cooldownSeconds < policy.minimum_sla_seconds || cooldownSeconds > policy.maximum_sla_seconds) {
        throw new Error(`Cooldown seconds must be between ${policy.minimum_sla_seconds} and ${policy.maximum_sla_seconds}`);
    }

    const now = input.now ?? new Date();
    const slaExpiresAt = new Date(now.getTime() + slaSeconds * 1000);
    const cooldownUntil = new Date(now.getTime() + cooldownSeconds * 1000);
    const manifest: LargeTransferManifest = {
        transfer_id: input.transferId ?? crypto.randomUUID(),
        revision: 1,
        sender_agent_id: input.senderAgentId,
        recipient_agent_id: input.recipientAgentId,
        size_bytes: fileStats.size,
        sha256: await hashFile(input.filePath),
        content_type: input.contentType ?? inferContentType(input.filePath),
        storage_state: 'sender_hosted',
        transport_addresses: transportAddresses,
        sla_expires_at: slaExpiresAt.toISOString(),
        cooldown_until: cooldownUntil.toISOString(),
        created_at: now.toISOString(),
        updated_at: now.toISOString()
    };

    if (input.metadata) {
        manifest.metadata = input.metadata;
    }

    const validation = validateLargeTransferManifest(manifest, policy);
    if (!validation.valid) {
        throw new Error(`Invalid transfer manifest: ${validation.errors.join('; ')}`);
    }

    return manifest;
}

export function validateLargeTransferManifest(
    manifest: LargeTransferManifest,
    policy: LargePayloadPolicy = LARGE_PAYLOAD_POLICY
): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const field of policy.required_manifest_fields) {
        if ((manifest as unknown as Record<string, unknown>)[field] === undefined) {
            errors.push(`Missing manifest field: ${field}`);
        }
    }

    if (!Number.isInteger(manifest.revision) || manifest.revision < 1) {
        errors.push('Manifest revision must be a positive integer');
    }
    if (!Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes < 0) {
        errors.push('Manifest size_bytes must be a non-negative safe integer');
    }
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
        errors.push('Manifest sha256 must be a 64-character hex digest');
    }
    if (!(policy.storage_states as readonly string[]).includes(manifest.storage_state)) {
        errors.push(`Unsupported storage_state: ${manifest.storage_state}`);
    }
    if (!Array.isArray(manifest.transport_addresses) || manifest.transport_addresses.length === 0) {
        errors.push('At least one transport address is required');
    }
    if (!Date.parse(manifest.sla_expires_at)) {
        errors.push('Manifest sla_expires_at must be an ISO timestamp');
    }
    if (!Date.parse(manifest.cooldown_until)) {
        errors.push('Manifest cooldown_until must be an ISO timestamp');
    }

    return { valid: errors.length === 0, errors };
}

export function nextManifestRevision(
    manifest: LargeTransferManifest,
    changes: Partial<Pick<LargeTransferManifest, 'storage_state' | 'transport_addresses' | 'metadata'>>,
    now: Date = new Date()
): LargeTransferManifest {
    const next: LargeTransferManifest = {
        ...manifest,
        ...changes,
        revision: manifest.revision + 1,
        updated_at: now.toISOString()
    };

    const validation = validateLargeTransferManifest(next);
    if (!validation.valid) {
        throw new Error(`Invalid transfer manifest revision: ${validation.errors.join('; ')}`);
    }

    return next;
}
