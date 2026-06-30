import { describe, test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { EnvoqSidecar } from '../src/sidecar/transfers.ts';
import { nextManifestRevision } from '../src/sidecar/manifest.ts';
import { FileSystemCloudStorageAdapter, type CloudStorageAdapter } from '../src/sidecar/cloud.ts';
import { S3CompatibleCloudStorageAdapter } from '../src/sidecar/cloud-providers.ts';
import { AGENT_ONBOARDING_POLICY_BUNDLE } from '../src/policies/onboarding.ts';

async function createSidecarFixture(
    agentId: string,
    options: { cloudAdapter?: CloudStorageAdapter } = {}
): Promise<{ sidecar: EnvoqSidecar; filePath: string; dir: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), `envoq-sidecar-${agentId}-`));
    const filePath = path.join(dir, 'artifact.txt');
    await writeFile(filePath, 'large payload fixture', 'utf8');

    const config = {
        agentId,
        hubSecret: 'test-secret',
        hubUrl: 'http://127.0.0.1:1/api/v1',
        storePath: path.join(dir, 'state.json'),
        policyBundle: AGENT_ONBOARDING_POLICY_BUNDLE
    };
    if (options.cloudAdapter !== undefined) {
        Object.assign(config, { cloudAdapter: options.cloudAdapter });
    }

    return {
        dir,
        filePath,
        sidecar: new EnvoqSidecar(config)
    };
}

describe('Envoq sidecar large-transfer state machine', () => {
    test('prepares sender-hosted manifests and verifies artifact checksums', async () => {
        const { sidecar, filePath } = await createSidecarFixture('agent-a');

        const record = await sidecar.prepareLargeTransfer({
            filePath,
            recipientAgentId: 'agent-b',
            transportAddresses: ['p2p://agent-a/artifact.txt'],
            slaSeconds: 300,
            cooldownSeconds: 300
        });

        assert.strictEqual(record.status, 'sender_hosted');
        assert.strictEqual(record.manifest.sender_agent_id, 'agent-a');
        assert.strictEqual(record.manifest.recipient_agent_id, 'agent-b');
        assert.strictEqual(record.manifest.storage_state, 'sender_hosted');
        assert.strictEqual(record.manifest.revision, 1);

        const verification = await sidecar.verifyArtifact(filePath, record.manifest.sha256);
        assert.strictEqual(verification.matches, true);
    });

    test('serves sender-hosted artifacts and downloads them into the receiver sandbox', async (t) => {
        const senderFixture = await createSidecarFixture('agent-a');
        const receiverFixture = await createSidecarFixture('agent-b');
        await senderFixture.sidecar.startFileServer({ host: '127.0.0.1', port: 0 });
        t.after(async () => {
            await senderFixture.sidecar.stopFileServer();
        });

        const record = await senderFixture.sidecar.prepareLargeTransfer({
            filePath: senderFixture.filePath,
            recipientAgentId: 'agent-b',
            slaSeconds: 300,
            cooldownSeconds: 300
        });

        assert.match(record.manifest.transport_addresses[0] ?? '', /^http:\/\/127\.0\.0\.1:/);
        assert.strictEqual(typeof record.manifest.metadata?.access_token, 'string');

        const result = await receiverFixture.sidecar.downloadTransferArtifact(record.manifest, {
            sandboxRoot: path.join(receiverFixture.dir, 'sandbox')
        });
        assert.strictEqual(result.record.status, 'delivered');
        assert.strictEqual(result.artifact.verified, true);
        assert.strictEqual(await readFile(result.artifact.file_path, 'utf8'), 'large payload fixture');
    });

    test('advertises and downloads sender-hosted artifacts over libp2p', async (t) => {
        const senderFixture = await createSidecarFixture('agent-a');
        const receiverFixture = await createSidecarFixture('agent-b');
        await senderFixture.sidecar.startLibp2pTransport({
            listen: ['/ip4/127.0.0.1/tcp/0/ws']
        });
        await receiverFixture.sidecar.startLibp2pTransport({
            listen: ['/ip4/127.0.0.1/tcp/0/ws']
        });
        t.after(async () => {
            await senderFixture.sidecar.stopLibp2pTransport();
            await receiverFixture.sidecar.stopLibp2pTransport();
        });

        const record = await senderFixture.sidecar.prepareLargeTransfer({
            filePath: senderFixture.filePath,
            recipientAgentId: 'agent-b',
            slaSeconds: 300,
            cooldownSeconds: 300
        });

        assert.ok(record.manifest.transport_addresses.some((address) => address.startsWith('libp2p:')));
        assert.strictEqual(record.manifest.metadata?.libp2p_peer_id, senderFixture.sidecar.libp2pTransport.status().peer_id);

        const result = await receiverFixture.sidecar.downloadTransferArtifact(record.manifest, {
            sandboxRoot: path.join(receiverFixture.dir, 'sandbox-libp2p'),
            timeoutMs: 30_000
        });
        assert.strictEqual(result.record.status, 'delivered');
        assert.strictEqual(result.artifact.verified, true);
        assert.match(result.artifact.source_url, /^libp2p:/);
        assert.strictEqual(await readFile(result.artifact.file_path, 'utf8'), 'large payload fixture');
    });

    test('ignores stale manifest revisions on the receiver side', async () => {
        const senderFixture = await createSidecarFixture('agent-a');
        const receiverFixture = await createSidecarFixture('agent-b');
        const record = await senderFixture.sidecar.prepareLargeTransfer({
            filePath: senderFixture.filePath,
            recipientAgentId: 'agent-b',
            transportAddresses: ['p2p://agent-a/artifact.txt'],
            slaSeconds: 300,
            cooldownSeconds: 300
        });
        const newerManifest = nextManifestRevision(record.manifest, {
            transport_addresses: ['p2p://agent-a/new-artifact.txt']
        });

        const accepted = await receiverFixture.sidecar.receiveTransferManifest(newerManifest);
        assert.strictEqual(accepted.accepted, true);
        assert.strictEqual(accepted.record.manifest.revision, 2);

        const stale = await receiverFixture.sidecar.receiveTransferManifest(record.manifest);
        assert.strictEqual(stale.accepted, false);
        assert.match(stale.reason ?? '', /ignored stale manifest revision/);
        assert.strictEqual(stale.record.manifest.revision, 2);
    });

    test('reconciles expired SLA and cloud cooldown into explicit actions', async () => {
        const { sidecar, filePath } = await createSidecarFixture('agent-a');
        const record = await sidecar.prepareLargeTransfer({
            filePath,
            recipientAgentId: 'agent-b',
            transportAddresses: ['p2p://agent-a/artifact.txt'],
            slaSeconds: 300,
            cooldownSeconds: 300
        });

        const expiredAt = new Date(Date.parse(record.manifest.sla_expires_at) + 1);
        const fallbackActions = await sidecar.reconcileTransfers(expiredAt);
        assert.strictEqual(fallbackActions.length, 1);
        assert.strictEqual(fallbackActions[0]?.action, 'cloud_fallback_required');
        assert.strictEqual(fallbackActions[0]?.status, 'fallback_pending');

        await sidecar.markCloudHosted(record.transfer_id, 'https://artifact-store.internal/transfers/artifact.txt');
        const cooldownExpiredAt = new Date(Date.parse(record.manifest.cooldown_until) + 1);
        const evictionActions = await sidecar.reconcileTransfers(cooldownExpiredAt);
        assert.strictEqual(evictionActions.length, 1);
        assert.strictEqual(evictionActions[0]?.action, 'cloud_eviction_ready');

        const stored = await sidecar.store.getTransfer(record.transfer_id);
        assert.ok(stored);
        assert.strictEqual(stored.status, 'evicting_cloud');
        assert.strictEqual(stored.manifest.storage_state, 'evicting_cloud');
        assert.ok(stored.manifest.revision > record.manifest.revision);
    });

    test('uploads cloud fallback and evicts it back to sender-hosted storage', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'envoq-cloud-adapter-'));
        const cloudRoot = path.join(dir, 'cloud');
        const adapter = new FileSystemCloudStorageAdapter(cloudRoot, 'https://storage.internal/envoq');
        const { sidecar, filePath } = await createSidecarFixture('agent-a', { cloudAdapter: adapter });
        const record = await sidecar.prepareLargeTransfer({
            filePath,
            recipientAgentId: 'agent-b',
            transportAddresses: ['p2p://agent-a/artifact.txt'],
            slaSeconds: 300,
            cooldownSeconds: 300
        });

        const cloudHosted = await sidecar.uploadCloudFallback(record.transfer_id);
        assert.strictEqual(cloudHosted.status, 'cloud_hosted');
        assert.strictEqual(cloudHosted.manifest.storage_state, 'cloud_hosted');
        assert.match(cloudHosted.manifest.transport_addresses[0] ?? '', /^https:\/\/storage\.internal\/envoq\//);
        const storageKey = cloudHosted.manifest.metadata?.cloud_storage_key;
        assert.strictEqual(typeof storageKey, 'string');
        await access(path.join(cloudRoot, storageKey as string));

        const evicted = await sidecar.evictCloudFallback(record.transfer_id);
        assert.strictEqual(evicted.status, 'sender_hosted');
        assert.strictEqual(evicted.manifest.storage_state, 'sender_hosted');
        assert.deepStrictEqual(evicted.manifest.transport_addresses, ['p2p://agent-a/artifact.txt']);
        assert.strictEqual(evicted.manifest.metadata?.cloud_storage_key, undefined);
        await assert.rejects(access(path.join(cloudRoot, storageKey as string)));
    });

    test('signs S3-compatible cloud uploads without provider SDKs', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'envoq-s3-cloud-'));
        const filePath = path.join(dir, 'artifact.txt');
        await writeFile(filePath, 'phase4 artifact', 'utf8');

        const calls: Array<{ url: string; init: RequestInit }> = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: url.toString(), init: init ?? {} });
            return new Response('', { status: 200 });
        }) as typeof fetch;

        try {
            const adapter = new S3CompatibleCloudStorageAdapter({
                provider: 's3',
                endpoint: 'https://s3.us-east-1.amazonaws.com',
                region: 'us-east-1',
                bucket: 'envoq-artifacts',
                accessKeyId: 'AKIA_TEST',
                secretAccessKey: 'secret'
            });
            const result = await adapter.upload({
                localPath: filePath,
                transferId: crypto.randomUUID(),
                revision: 3,
                fileName: 'artifact.txt'
            });

            assert.strictEqual(result.provider, 's3');
            assert.match(result.storage_key, /rev-3\/artifact\.txt$/);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0]?.init.method, 'PUT');
            const headers = calls[0]?.init.headers as Record<string, string>;
            const authorization = headers.authorization;
            if (typeof authorization !== 'string') {
                throw new Error('Missing S3 authorization header');
            }
            assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\//);
            const uploadUrl = calls[0]?.url;
            if (typeof uploadUrl !== 'string') {
                throw new Error('Missing captured upload URL');
            }
            assert.match(uploadUrl, /^https:\/\/envoq-artifacts\.s3\.us-east-1\.amazonaws\.com\//);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
