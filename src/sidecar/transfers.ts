import crypto from 'crypto';
import path from 'path';
import type { CloudStorageAdapter } from './cloud.ts';
import { createCloudStorageAdapterFromEnv } from './cloud-providers.ts';
import { EnvoqHubClient } from './client.ts';
import { SidecarInbox, type IncomingTunnelMessageInput, type SidecarInboxMessage } from './inbox.ts';
import {
    buildTransferFileUrl,
    SidecarFileServer,
    type SidecarFileServerOptions,
    type SidecarFileServerStatus
} from './file-server.ts';
import type {
    Libp2pTransferTransport,
    Libp2pTransportOptions,
    Libp2pTransportStatus
} from './libp2p-transport.ts';
import {
    createLargeTransferManifest,
    hashFile,
    nextManifestRevision,
    type CreateManifestInput,
    type LargeTransferManifest
} from './manifest.ts';
import {
    assertInlinePayloadAllowed,
    enforceLargeTransferManifest,
    getPolicyBundle,
    type PolicyBundle
} from './policy.ts';
import {
    createTransferRecord,
    SidecarStore,
    type TransferRecord,
    type TransferStatus
} from './store.ts';
import {
    downloadManifestArtifact,
    type DownloadedArtifact,
    type DownloadSandboxOptions
} from './sandbox.ts';
import { hasTransportKind } from './transport-registry.ts';
import { EnvoqTunnelClient, type EnvoqTunnelStatus } from './tunnel-client.ts';

export interface EnvoqSidecarConfig {
    hubUrl: string;
    hubSecret: string;
    agentId: string;
    storePath?: string;
    inboxPath?: string;
    identityPath?: string;
    policyBundle?: PolicyBundle;
    cloudAdapter?: CloudStorageAdapter;
    libp2pOptions?: Libp2pTransportOptions;
}

export interface DiscoverAgentsInput {
    namespace?: string;
    skill?: string;
    status?: string;
    limit?: number;
}

export interface PrepareLargeTransferInput {
    filePath: string;
    recipientAgentId: string;
    transportAddresses?: string[];
    slaSeconds?: number;
    cooldownSeconds?: number;
    contentType?: string;
    metadata?: Record<string, unknown>;
}

export interface TransferSlaProposalInput {
    recipientAgentId: string;
    fileName?: string;
    sizeBytes: number;
    sha256?: string;
    contentType?: string;
    slaSeconds?: number;
    cooldownSeconds?: number;
}

export interface TransferSlaProposal {
    type: 'envoq.large_payload_sla_proposal';
    policy_id: string;
    proposal_id: string;
    sender_agent_id: string;
    recipient_agent_id: string;
    size_bytes: number;
    sla_seconds: number;
    cooldown_seconds: number;
    proposed_at: string;
    expires_at: string;
    file_name?: string;
    sha256?: string;
    content_type?: string;
}

export interface TransferSlaAcceptance {
    type: 'envoq.large_payload_sla_acceptance';
    policy_id: string;
    proposal_id: string;
    sender_agent_id: string;
    recipient_agent_id: string;
    accepted_at: string;
    sla_seconds: number;
    cooldown_seconds: number;
}

export interface ReconcileAction {
    transfer_id: string;
    action: 'cloud_fallback_required' | 'cloud_eviction_ready';
    reason: string;
    revision: number;
    status: TransferStatus;
}

const SLA_EXPIRABLE_STATUSES: readonly TransferStatus[] = [
    'drafted',
    'sla_proposed',
    'sla_accepted',
    'sender_hosted'
];

function stoppedLibp2pStatus(): Libp2pTransportStatus {
    return {
        running: false,
        protocol: '/envoq/large-transfer/1.0.0',
        multiaddrs: [],
        advertised_addresses: [],
        relay_multiaddrs: [],
        listen_multiaddrs: []
    };
}

export class EnvoqSidecar {
    public readonly agentId: string;
    public readonly store: SidecarStore;
    public readonly inbox: SidecarInbox;
    public readonly client: EnvoqHubClient;
    public readonly fileServer: SidecarFileServer;
    public get libp2pTransport(): Libp2pTransferTransport {
        if (!this.libp2pTransportInstance) {
            throw new Error('Libp2p transport has not been started');
        }
        return this.libp2pTransportInstance;
    }

    private readonly hubUrl: string;
    private readonly policyBundle: PolicyBundle | undefined;
    private readonly cloudAdapter: CloudStorageAdapter;
    private readonly libp2pOptions: Libp2pTransportOptions | undefined;
    private readonly tunnelClient: EnvoqTunnelClient;
    private libp2pTransportInstance: Libp2pTransferTransport | undefined;

    constructor(config: EnvoqSidecarConfig) {
        this.agentId = config.agentId;
        this.hubUrl = config.hubUrl.replace(/\/+$/, '');
        this.store = new SidecarStore(config.storePath);
        this.inbox = new SidecarInbox(config.inboxPath);
        this.fileServer = new SidecarFileServer(this.store);
        this.libp2pOptions = config.libp2pOptions;
        this.client = new EnvoqHubClient({
            hubUrl: this.hubUrl,
            hubSecret: config.hubSecret,
            agentId: config.agentId
        });
        const tunnelConfig = {
            hubUrl: this.hubUrl,
            apiKey: config.hubSecret,
            agentId: config.agentId,
            onMessage: async (message: IncomingTunnelMessageInput) => await this.inbox.append(message)
        };
        this.tunnelClient = new EnvoqTunnelClient(
            config.identityPath === undefined
                ? tunnelConfig
                : { ...tunnelConfig, identityPath: config.identityPath }
        );
        this.policyBundle = config.policyBundle;
        this.cloudAdapter = config.cloudAdapter ?? createCloudStorageAdapterFromEnv();
    }

    async getPolicy(forceRefresh: boolean = false): Promise<Awaited<ReturnType<typeof getPolicyBundle>>> {
        const options: {
            hubUrl: string;
            forceRefresh: boolean;
            policyBundle?: PolicyBundle;
        } = {
            hubUrl: this.hubUrl,
            forceRefresh
        };
        if (this.policyBundle !== undefined) {
            options.policyBundle = this.policyBundle;
        }
        return await getPolicyBundle(options);
    }

    async register(webhookUrl: string): Promise<unknown> {
        return await this.client.register(webhookUrl);
    }

    async sendMessage(recipientId: string, payload: Record<string, unknown>): Promise<string> {
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        assertInlinePayloadAllowed(payload, policy);
        return await this.client.sendMessage(recipientId, payload);
    }

    async discoverAgents(input: DiscoverAgentsInput = {}): Promise<unknown> {
        return await this.client.discoverAgents(input);
    }

    async resolveAgent(name: string, namespace?: string): Promise<unknown> {
        return await this.client.resolveAgent(name, namespace);
    }

    async status(): Promise<{
        agent_id: string;
        hub_url: string;
        transfers: { total: number; by_status: Record<string, number> };
        inbox: { total: number; unread: number; acknowledged: number };
        tunnel: EnvoqTunnelStatus;
        policy: { source: string; security_policy_id: string; large_payload_policy_id: string };
        file_server: SidecarFileServerStatus;
        libp2p: Libp2pTransportStatus;
    }> {
        const policy = await this.getPolicy();
        const transfers = await this.store.listTransfers();
        const inbox = await this.inbox.counts();
        const byStatus: Record<string, number> = {};
        for (const transfer of transfers) {
            byStatus[transfer.status] = (byStatus[transfer.status] ?? 0) + 1;
        }

        return {
            agent_id: this.agentId,
            hub_url: this.hubUrl,
            transfers: {
                total: transfers.length,
                by_status: byStatus
            },
            inbox,
            tunnel: this.tunnelClient.status(),
            policy: {
                source: policy.source,
                security_policy_id: policy.bundle.security_policy.policy_id,
                large_payload_policy_id: policy.bundle.large_payload_policy.policy_id
            },
            file_server: this.fileServer.status,
            libp2p: this.libp2pTransportInstance?.status() ?? stoppedLibp2pStatus()
        };
    }

    async startTunnel(): Promise<EnvoqTunnelStatus> {
        await this.tunnelClient.start();
        return this.tunnelClient.status();
    }

    stopTunnel(): EnvoqTunnelStatus {
        this.tunnelClient.stop();
        return this.tunnelClient.status();
    }

    async listInbox(options: { includeAcknowledged?: boolean; limit?: number } = {}): Promise<SidecarInboxMessage[]> {
        return await this.inbox.list(options);
    }

    async readInbox(id: string): Promise<SidecarInboxMessage | null> {
        return await this.inbox.read(id);
    }

    async ackInbox(id: string): Promise<SidecarInboxMessage | null> {
        return await this.inbox.ack(id);
    }

    async startFileServer(options: SidecarFileServerOptions = {}): Promise<SidecarFileServerStatus> {
        return await this.fileServer.start(options);
    }

    async stopFileServer(): Promise<void> {
        await this.fileServer.stop();
    }

    async startLibp2pTransport(options: Libp2pTransportOptions = {}): Promise<Libp2pTransportStatus> {
        const transport = await this.getLibp2pTransport();
        return await transport.start(options);
    }

    async stopLibp2pTransport(): Promise<void> {
        await this.libp2pTransportInstance?.stop();
    }

    async proposeTransferSla(input: TransferSlaProposalInput): Promise<{ stream_id: string; proposal: TransferSlaProposal }> {
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
            throw new Error('sizeBytes must be a non-negative safe integer');
        }
        if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.sha256)) {
            throw new Error('sha256 must be a 64-character hex digest when provided');
        }

        const slaSeconds = this.normalizeSlaSeconds(input.slaSeconds ?? policy.default_sla_seconds, policy);
        const cooldownSeconds = this.normalizeSlaSeconds(input.cooldownSeconds ?? slaSeconds, policy);
        const now = new Date();
        const proposal: TransferSlaProposal = {
            type: 'envoq.large_payload_sla_proposal',
            policy_id: policy.policy_id,
            proposal_id: crypto.randomUUID(),
            sender_agent_id: this.agentId,
            recipient_agent_id: input.recipientAgentId,
            size_bytes: input.sizeBytes,
            sla_seconds: slaSeconds,
            cooldown_seconds: cooldownSeconds,
            proposed_at: now.toISOString(),
            expires_at: new Date(now.getTime() + slaSeconds * 1000).toISOString()
        };
        if (input.fileName !== undefined) {
            proposal.file_name = input.fileName;
        }
        if (input.sha256 !== undefined) {
            proposal.sha256 = input.sha256;
        }
        if (input.contentType !== undefined) {
            proposal.content_type = input.contentType;
        }

        assertInlinePayloadAllowed(proposal, policy);
        const streamId = await this.client.sendMessage(input.recipientAgentId, proposal as unknown as Record<string, unknown>);
        return { stream_id: streamId, proposal };
    }

    async acceptTransferSla(proposal: TransferSlaProposal): Promise<{ stream_id: string; acceptance: TransferSlaAcceptance }> {
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        if (proposal.type !== 'envoq.large_payload_sla_proposal') {
            throw new Error('Invalid SLA proposal type');
        }
        if (proposal.recipient_agent_id !== this.agentId) {
            throw new Error(`SLA proposal is addressed to ${proposal.recipient_agent_id}, not ${this.agentId}`);
        }
        this.normalizeSlaSeconds(proposal.sla_seconds, policy);
        this.normalizeSlaSeconds(proposal.cooldown_seconds, policy);

        const acceptance: TransferSlaAcceptance = {
            type: 'envoq.large_payload_sla_acceptance',
            policy_id: policy.policy_id,
            proposal_id: proposal.proposal_id,
            sender_agent_id: proposal.sender_agent_id,
            recipient_agent_id: this.agentId,
            accepted_at: new Date().toISOString(),
            sla_seconds: proposal.sla_seconds,
            cooldown_seconds: proposal.cooldown_seconds
        };
        assertInlinePayloadAllowed(acceptance, policy);
        const streamId = await this.client.sendMessage(proposal.sender_agent_id, acceptance as unknown as Record<string, unknown>);
        return { stream_id: streamId, acceptance };
    }

    async prepareLargeTransfer(input: PrepareLargeTransferInput): Promise<TransferRecord> {
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        const metadata: Record<string, unknown> = {
            ...(input.metadata ?? {}),
            file_name: typeof input.metadata?.file_name === 'string'
                ? input.metadata.file_name
                : path.basename(input.filePath)
        };
        const transferId = crypto.randomUUID();
        const transportAddresses = [...(input.transportAddresses ?? [])];
        const libp2pTransport = this.libp2pTransportInstance;
        const hasManagedSenderTransport = Boolean(libp2pTransport?.isRunning()) || this.fileServer.getPublicUrl() !== null;
        if (hasManagedSenderTransport && typeof metadata.access_token !== 'string') {
            metadata.access_token = crypto.randomBytes(32).toString('hex');
        }
        if (libp2pTransport?.isRunning()) {
            transportAddresses.push(...libp2pTransport.advertisedAddresses());
            metadata.libp2p_peer_id = libp2pTransport.status().peer_id;
        }
        const fileServerUrl = this.fileServer.getPublicUrl();
        if (fileServerUrl) {
            const accessToken = metadata.access_token as string;
            transportAddresses.push(buildTransferFileUrl(fileServerUrl, transferId, accessToken));
        }
        metadata.sender_hosted_transport_addresses = [...transportAddresses];

        const manifestInput: CreateManifestInput = {
            filePath: input.filePath,
            senderAgentId: this.agentId,
            recipientAgentId: input.recipientAgentId,
            transportAddresses,
            transferId,
            metadata
        };
        if (input.slaSeconds !== undefined) {
            manifestInput.slaSeconds = input.slaSeconds;
        }
        if (input.cooldownSeconds !== undefined) {
            manifestInput.cooldownSeconds = input.cooldownSeconds;
        }
        if (input.contentType !== undefined) {
            manifestInput.contentType = input.contentType;
        }
        const manifest = await createLargeTransferManifest(manifestInput, policy);
        const record = createTransferRecord({
            role: 'sender',
            status: 'sender_hosted',
            manifest,
            localPath: input.filePath,
            event: 'prepared_sender_hosted_manifest'
        });
        return await this.store.saveTransfer(record, 'prepared_large_transfer');
    }

    async publishTransferManifest(transferId: string): Promise<TransferRecord> {
        const record = await this.requireTransfer(transferId);
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        enforceLargeTransferManifest(record.manifest, policy);

        const payload = {
            type: 'envoq.large_payload_manifest',
            policy_id: policy.policy_id,
            manifest: record.manifest
        };
        assertInlinePayloadAllowed(payload, policy);
        const streamId = await this.client.sendMessage(record.manifest.recipient_agent_id, payload);

        return await this.store.updateTransfer(
            transferId,
            (current) => ({
                ...current,
                last_published_stream_id: streamId
            }),
            'published_large_transfer_manifest'
        );
    }

    async receiveTransferManifest(manifest: LargeTransferManifest): Promise<{ accepted: boolean; record: TransferRecord; reason?: string }> {
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        enforceLargeTransferManifest(manifest, policy);

        const existing = await this.store.getTransfer(manifest.transfer_id);
        if (existing && manifest.revision < existing.manifest.revision) {
            return {
                accepted: false,
                record: existing,
                reason: `ignored stale manifest revision ${manifest.revision}; latest is ${existing.manifest.revision}`
            };
        }

        const record = createTransferRecord({
            role: 'receiver',
            status: 'receiver_fetching',
            manifest,
            event: 'received_large_transfer_manifest'
        });
        const saved = await this.store.saveTransfer(record, 'accepted_large_transfer_manifest');
        return { accepted: true, record: saved };
    }

    async verifyArtifact(filePath: string, expectedSha256: string): Promise<{ sha256: string; matches: boolean }> {
        const sha256 = await hashFile(filePath);
        return {
            sha256,
            matches: sha256.toLowerCase() === expectedSha256.toLowerCase()
        };
    }

    async downloadTransferArtifact(
        manifest: LargeTransferManifest,
        options: DownloadSandboxOptions = {}
    ): Promise<{ artifact: DownloadedArtifact; record: TransferRecord }> {
        const received = await this.receiveTransferManifest(manifest);
        if (!received.accepted && received.record.status === 'delivered' && received.record.local_path) {
            return {
                artifact: {
                    transfer_id: received.record.transfer_id,
                    file_path: received.record.local_path,
                    sha256: received.record.manifest.sha256,
                    size_bytes: received.record.manifest.size_bytes,
                    verified: true,
                    source_url: received.record.manifest.transport_addresses[0] ?? ''
                },
                record: received.record
            };
        }

        let artifact: DownloadedArtifact;
        const libp2pTransport = this.libp2pTransportInstance;
        if (libp2pTransport?.isRunning() && hasTransportKind(received.record.manifest, 'libp2p')) {
            try {
                artifact = await libp2pTransport.fetchArtifact(received.record.manifest, options);
            } catch (error) {
                if (!hasTransportKind(received.record.manifest, 'http')) {
                    throw error;
                }
                artifact = await downloadManifestArtifact(received.record.manifest, options);
            }
        } else {
            artifact = await downloadManifestArtifact(received.record.manifest, options);
        }
        const record = await this.store.updateTransfer(
            received.record.transfer_id,
            (current) => ({
                ...current,
                status: 'delivered',
                local_path: artifact.file_path
            }),
            'downloaded_and_verified_artifact'
        );
        return { artifact, record };
    }

    async markCloudHosted(
        transferId: string,
        cloudUrl: string,
        metadata: Record<string, unknown> = {}
    ): Promise<TransferRecord> {
        const record = await this.requireTransfer(transferId);
        const existingMetadata = record.manifest.metadata ?? {};
        const senderHostedAddresses = Array.isArray(existingMetadata.sender_hosted_transport_addresses)
            ? existingMetadata.sender_hosted_transport_addresses
            : record.manifest.transport_addresses;
        const nextManifest = nextManifestRevision(record.manifest, {
            storage_state: 'cloud_hosted',
            transport_addresses: [cloudUrl],
            metadata: {
                ...existingMetadata,
                ...metadata,
                cloud_url: cloudUrl,
                sender_hosted_transport_addresses: senderHostedAddresses
            }
        });
        return await this.store.updateTransfer(
            transferId,
            (current) => ({
                ...current,
                status: 'cloud_hosted',
                manifest: nextManifest,
                fallback_attempts: current.fallback_attempts + 1
            }),
            'marked_cloud_hosted'
        );
    }

    async markDelivered(transferId: string): Promise<TransferRecord> {
        return await this.store.updateTransfer(
            transferId,
            (current) => ({
                ...current,
                status: 'delivered'
            }),
            'marked_delivered'
        );
    }

    async uploadCloudFallback(transferId: string): Promise<TransferRecord> {
        const record = await this.requireTransfer(transferId);
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        if (record.role !== 'sender') {
            throw new Error('Only sender-side transfer records can upload cloud fallbacks');
        }
        if (!record.local_path) {
            throw new Error('Cannot upload cloud fallback without a local artifact path');
        }
        if (record.fallback_attempts >= policy.cloud_fallback.max_fallback_attempts_per_transfer) {
            throw new Error('Cloud fallback attempt limit reached for this transfer');
        }

        const result = await this.cloudAdapter.upload({
            localPath: record.local_path,
            transferId: record.transfer_id,
            revision: record.manifest.revision,
            fileName: typeof record.manifest.metadata?.file_name === 'string'
                ? record.manifest.metadata.file_name
                : path.basename(record.local_path)
        });

        return await this.markCloudHosted(record.transfer_id, result.url, {
            cloud_provider: result.provider,
            cloud_storage_key: result.storage_key,
            cloud_uploaded_at: new Date().toISOString()
        });
    }

    async evictCloudFallback(
        transferId: string,
        options: { publishRestoredManifest?: boolean } = {}
    ): Promise<TransferRecord> {
        const record = await this.requireTransfer(transferId);
        if (record.role !== 'sender') {
            throw new Error('Only sender-side transfer records can evict cloud fallbacks');
        }

        const metadata = record.manifest.metadata ?? {};
        const restoreAddresses = this.senderHostedAddresses(record);
        const storageKey = metadata.cloud_storage_key;
        const nextMetadata = { ...metadata };
        delete nextMetadata.cloud_url;
        delete nextMetadata.cloud_provider;
        delete nextMetadata.cloud_storage_key;
        delete nextMetadata.cloud_uploaded_at;
        nextMetadata.cloud_evicted_at = new Date().toISOString();
        nextMetadata.sender_hosted_transport_addresses = restoreAddresses;

        const restoredManifest = nextManifestRevision(record.manifest, {
            storage_state: 'sender_hosted',
            transport_addresses: restoreAddresses,
            metadata: nextMetadata
        });

        const restored = await this.store.updateTransfer(
            transferId,
            (current) => ({
                ...current,
                status: 'sender_hosted',
                manifest: restoredManifest
            }),
            'prepared_cloud_eviction_manifest'
        );

        if (options.publishRestoredManifest === true) {
            await this.publishTransferManifest(transferId);
        }

        if (typeof storageKey === 'string' && storageKey.length > 0) {
            await this.cloudAdapter.delete(storageKey);
        }

        return await this.store.updateTransfer(
            transferId,
            (current) => current,
            'evicted_cloud_artifact'
        );
    }

    async reconcileTransfers(now: Date = new Date()): Promise<ReconcileAction[]> {
        const policy = (await this.getPolicy()).bundle.large_payload_policy;
        const transfers = await this.store.listTransfers();
        const actions: ReconcileAction[] = [];

        for (const record of transfers) {
            if (record.role !== 'sender') {
                continue;
            }

            const slaExpired = Date.parse(record.manifest.sla_expires_at) <= now.getTime();
            if (SLA_EXPIRABLE_STATUSES.includes(record.status) && slaExpired) {
                const updated = await this.store.updateTransfer(
                    record.transfer_id,
                    (current) => ({
                        ...current,
                        status: current.fallback_attempts >= policy.cloud_fallback.max_fallback_attempts_per_transfer
                            ? 'expired'
                            : 'fallback_pending'
                    }),
                    'reconciled_sla_expiry'
                );
                actions.push({
                    transfer_id: updated.transfer_id,
                    action: 'cloud_fallback_required',
                    reason: updated.status === 'expired' ? 'fallback_attempt_limit_reached' : 'sla_expired',
                    revision: updated.manifest.revision,
                    status: updated.status
                });
                continue;
            }

            const cooldownExpired = Date.parse(record.manifest.cooldown_until) <= now.getTime();
            if (record.status === 'cloud_hosted' && cooldownExpired) {
                const nextManifest = nextManifestRevision(record.manifest, {
                    storage_state: 'evicting_cloud'
                }, now);
                const updated = await this.store.updateTransfer(
                    record.transfer_id,
                    (current) => ({
                        ...current,
                        status: 'evicting_cloud',
                        manifest: nextManifest
                    }),
                    'reconciled_cloud_eviction'
                );
                actions.push({
                    transfer_id: updated.transfer_id,
                    action: 'cloud_eviction_ready',
                    reason: 'cooldown_expired',
                    revision: updated.manifest.revision,
                    status: updated.status
                });
            }
        }

        return actions;
    }

    private async requireTransfer(transferId: string): Promise<TransferRecord> {
        const record = await this.store.getTransfer(transferId);
        if (!record) {
            throw new Error(`Transfer not found: ${transferId}`);
        }
        return record;
    }

    private normalizeSlaSeconds(
        value: number,
        policy: { minimum_sla_seconds: number; maximum_sla_seconds: number } | undefined = this.policyBundle?.large_payload_policy
    ): number {
        const min = policy?.minimum_sla_seconds ?? 300;
        const max = policy?.maximum_sla_seconds ?? 604_800;
        if (!Number.isSafeInteger(value) || value < min || value > max) {
            throw new Error(`SLA seconds must be between ${min} and ${max}`);
        }
        return value;
    }

    private senderHostedAddresses(record: TransferRecord): string[] {
        const addresses = record.manifest.metadata?.sender_hosted_transport_addresses;
        if (
            Array.isArray(addresses)
            && addresses.length > 0
            && addresses.every((entry) => typeof entry === 'string' && entry.length > 0)
        ) {
            return addresses as string[];
        }
        const currentHttpAddress = this.fileServer.getPublicUrl()
            ? record.manifest.transport_addresses.filter((address) => !address.startsWith('https://artifact-store.internal/'))
            : record.manifest.transport_addresses;
        if (currentHttpAddress.length === 0) {
            throw new Error('No sender-hosted transport address is available for cloud eviction');
        }
        return currentHttpAddress;
    }

    private async getLibp2pTransport(): Promise<Libp2pTransferTransport> {
        if (!this.libp2pTransportInstance) {
            const { Libp2pTransferTransport } = await import('./libp2p-transport.ts');
            this.libp2pTransportInstance = new Libp2pTransferTransport(this.store, this.libp2pOptions);
        }
        return this.libp2pTransportInstance;
    }
}
