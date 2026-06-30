import crypto, { timingSafeEqual } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import path from 'path';
import { once } from 'events';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p, Stream } from '@libp2p/interface';
import type { LargeTransferManifest } from './manifest.ts';
import type { SidecarStore, TransferRecord } from './store.ts';
import type { DownloadedArtifact, DownloadSandboxOptions } from './sandbox.ts';

export const ENVOQ_LIBP2P_TRANSFER_PROTOCOL = '/envoq/large-transfer/1.0.0';

export interface Libp2pTransportOptions {
    listen?: string[];
    announce?: string[];
    bootstrap?: string[];
    relays?: string[];
    dialTimeoutMs?: number;
    transferTimeoutMs?: number;
    chunkBytes?: number;
}

export interface Libp2pTransportStatus {
    running: boolean;
    protocol: string;
    peer_id?: string;
    multiaddrs: string[];
    advertised_addresses: string[];
    relay_multiaddrs: string[];
    listen_multiaddrs: string[];
}

interface ArtifactRequest {
    type: 'get_artifact';
    transfer_id: string;
    access_token?: string;
}

interface ArtifactHeader {
    type: 'artifact_metadata';
    transfer_id: string;
    size_bytes: number;
    sha256: string;
    content_type: string;
    file_name?: string;
}

const DEFAULT_LISTEN_MULTIADDRS = [
    '/ip4/0.0.0.0/tcp/0',
    '/ip4/0.0.0.0/tcp/0/ws',
    '/p2p-circuit'
];
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const WEBRTC_PACKAGE = '@libp2p/webrtc';
type Libp2pTransportFactory = ReturnType<typeof tcp>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function envList(key: string): string[] {
    const raw = process.env[key];
    if (!raw) {
        return [];
    }
    return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function safeSegment(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'artifact';
}

function bufferFromChunk(chunk: unknown): Buffer {
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk);
    }
    const maybeList = chunk as { subarray?: () => Uint8Array };
    if (typeof maybeList?.subarray === 'function') {
        return Buffer.from(maybeList.subarray());
    }
    throw new Error('Unsupported libp2p stream chunk type');
}

function encodeJson(value: unknown): Uint8Array {
    return encoder.encode(JSON.stringify(value));
}

function encodeControlFrame(value: unknown): Uint8Array {
    const payload = encodeJson(value);
    if (payload.byteLength > MAX_CONTROL_FRAME_BYTES) {
        throw new Error('Libp2p control frame exceeded maximum size');
    }
    const frame = Buffer.alloc(4 + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength, 0);
    frame.set(payload, 4);
    return frame;
}

function decodeControlFrame<T>(frame: Buffer): T {
    return JSON.parse(decoder.decode(frame)) as T;
}

function metadataFileName(manifest: LargeTransferManifest): string {
    const fileName = manifest.metadata?.file_name;
    return typeof fileName === 'string' && fileName.length > 0
        ? safeSegment(fileName)
        : `${safeSegment(manifest.transfer_id)}.artifact`;
}

function sandboxPath(root: string, manifest: LargeTransferManifest): string {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, safeSegment(manifest.transfer_id), `rev-${manifest.revision}`);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error('Resolved sandbox path escaped the configured sandbox root');
    }
    return resolvedPath;
}

function defaultSandboxRoot(): string {
    return process.env.ENVOQ_SIDECAR_SANDBOX_DIR
        || path.join(process.cwd(), '.envoq_sidecar', 'sandbox');
}

function transferAccessToken(record: TransferRecord): string | null {
    const token = record.manifest.metadata?.access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
}

function timingSafeStringEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeLibp2pAddress(address: string): string {
    return address.startsWith('libp2p:') ? address.slice('libp2p:'.length) : address;
}

function isLibp2pAddress(address: string): boolean {
    return address.startsWith('libp2p:')
        || address.startsWith('/ip4/')
        || address.startsWith('/ip6/')
        || address.startsWith('/dns4/')
        || address.startsWith('/dns6/')
        || address.startsWith('/dnsaddr/');
}

function selectLibp2pAddress(manifest: LargeTransferManifest): string {
    const address = manifest.transport_addresses.find(isLibp2pAddress);
    if (!address) {
        throw new Error('Manifest does not contain a libp2p transport address');
    }
    return address;
}

async function loadOptionalWebRtcTransport(): Promise<(() => Libp2pTransportFactory) | null> {
    try {
        const loaded = await import(WEBRTC_PACKAGE) as { webRTC?: () => Libp2pTransportFactory };
        return typeof loaded.webRTC === 'function' ? loaded.webRTC : null;
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
            return null;
        }
        throw error;
    }
}

async function waitForDrain(stream: Stream, timeoutMs: number): Promise<void> {
    await stream.onDrain({ signal: AbortSignal.timeout(timeoutMs) });
}

async function sendStreamMessage(stream: Stream, data: Uint8Array, timeoutMs: number): Promise<void> {
    if (!stream.send(data)) {
        await waitForDrain(stream, timeoutMs);
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

class StreamByteReader {
    private readonly iterator: AsyncIterator<unknown>;
    private readonly buffers: Buffer[] = [];

    constructor(stream: Stream) {
        this.iterator = stream[Symbol.asyncIterator]();
    }

    async readControlFrame<T>(timeoutMs: number): Promise<T> {
        const lengthBuffer = await this.readExactly(4, timeoutMs);
        const length = lengthBuffer.readUInt32BE(0);
        if (length === 0 || length > MAX_CONTROL_FRAME_BYTES) {
            throw new Error('Invalid libp2p control frame length');
        }
        return decodeControlFrame<T>(await this.readExactly(length, timeoutMs));
    }

    async *readRemaining(timeoutMs: number): AsyncGenerator<Buffer> {
        while (this.buffers.length > 0) {
            yield this.buffers.shift() as Buffer;
        }
        while (await this.pull(timeoutMs)) {
            while (this.buffers.length > 0) {
                yield this.buffers.shift() as Buffer;
            }
        }
    }

    private async readExactly(length: number, timeoutMs: number): Promise<Buffer> {
        const output = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
            if (this.buffers.length === 0) {
                const ok = await this.pull(timeoutMs);
                if (!ok) {
                    throw new Error('Libp2p stream closed before expected control frame');
                }
            }

            const buffer = this.buffers.shift();
            if (!buffer) {
                continue;
            }
            const needed = length - offset;
            if (buffer.length <= needed) {
                buffer.copy(output, offset);
                offset += buffer.length;
            } else {
                buffer.copy(output, offset, 0, needed);
                this.buffers.unshift(buffer.subarray(needed));
                offset += needed;
            }
        }
        return output;
    }

    private async pull(timeoutMs: number): Promise<boolean> {
        const result = await withTimeout(
            this.iterator.next(),
            timeoutMs,
            'Timed out waiting for libp2p stream data'
        );
        if (result.done === true || result.value === undefined) {
            return false;
        }
        const buffer = bufferFromChunk(result.value);
        if (buffer.length > 0) {
            this.buffers.push(buffer);
        }
        return true;
    }
}

export class Libp2pTransferTransport {
    private node: Libp2p | null = null;
    private readonly store: SidecarStore;
    private readonly defaultOptions: Libp2pTransportOptions;
    private relayMultiaddrs: string[] = [];
    private listenMultiaddrs: string[] = [];
    private chunkBytes = 256 * 1024;

    constructor(store: SidecarStore, defaultOptions: Libp2pTransportOptions = {}) {
        this.store = store;
        this.defaultOptions = defaultOptions;
    }

    isRunning(): boolean {
        return this.node?.status === 'started';
    }

    status(): Libp2pTransportStatus {
        const multiaddrs = this.node?.getMultiaddrs().map((addr) => addr.toString()) ?? [];
        return {
            running: this.isRunning(),
            protocol: ENVOQ_LIBP2P_TRANSFER_PROTOCOL,
            ...(this.node ? { peer_id: this.node.peerId.toString() } : {}),
            multiaddrs,
            advertised_addresses: multiaddrs.map((addr) => `libp2p:${addr}`),
            relay_multiaddrs: this.relayMultiaddrs,
            listen_multiaddrs: this.listenMultiaddrs
        };
    }

    advertisedAddresses(): string[] {
        return this.status().advertised_addresses;
    }

    async start(options: Libp2pTransportOptions = {}): Promise<Libp2pTransportStatus> {
        if (this.node) {
            return this.status();
        }

        const listen = options.listen
            ?? this.defaultOptions.listen
            ?? envList('ENVOQ_LIBP2P_LISTEN');
        const announce = options.announce
            ?? this.defaultOptions.announce
            ?? envList('ENVOQ_LIBP2P_ANNOUNCE');
        const relays = options.relays
            ?? this.defaultOptions.relays
            ?? envList('ENVOQ_LIBP2P_RELAYS');
        const bootstrapPeers = [
            ...(options.bootstrap ?? this.defaultOptions.bootstrap ?? envList('ENVOQ_LIBP2P_BOOTSTRAP')),
            ...relays
        ];
        const dialTimeoutMs = options.dialTimeoutMs ?? this.defaultOptions.dialTimeoutMs ?? 10_000;
        this.chunkBytes = options.chunkBytes ?? this.defaultOptions.chunkBytes ?? this.chunkBytes;
        this.listenMultiaddrs = listen.length > 0 ? listen : DEFAULT_LISTEN_MULTIADDRS;
        this.relayMultiaddrs = relays;

        const webRtcTransport = await loadOptionalWebRtcTransport();
        const listenMultiaddrs = webRtcTransport
            ? this.listenMultiaddrs
            : this.listenMultiaddrs.filter((addr) => !addr.includes('/webrtc'));
        this.listenMultiaddrs = listenMultiaddrs;

        const transports = [
            tcp(),
            webSockets(),
            ...(webRtcTransport ? [webRtcTransport()] : []),
            circuitRelayTransport()
        ];

        const node = await createLibp2p({
            addresses: {
                listen: listenMultiaddrs,
                ...(announce.length > 0 ? { announce } : {})
            },
            transports,
            connectionEncrypters: [noise()],
            streamMuxers: [yamux()],
            ...(bootstrapPeers.length > 0 ? { peerDiscovery: [bootstrap({ list: bootstrapPeers })] } : {}),
            connectionGater: {
                denyDialMultiaddr: () => false
            },
            services: {
                identify: identify()
            }
        });

        await node.handle(
            ENVOQ_LIBP2P_TRANSFER_PROTOCOL,
            (stream) => {
                void this.handleIncomingStream(stream).catch((error) => {
                    stream.abort(error instanceof Error ? error : new Error(String(error)));
                });
            },
            {
                force: true,
                runOnLimitedConnection: true,
                maxInboundStreams: 64,
                maxOutboundStreams: 64
            }
        );

        this.node = node;
        for (const relay of relays) {
            await this.dialRelay(relay, dialTimeoutMs).catch(() => undefined);
        }
        return this.status();
    }

    async stop(): Promise<void> {
        const node = this.node;
        if (!node) {
            return;
        }
        await node.unhandle(ENVOQ_LIBP2P_TRANSFER_PROTOCOL).catch(() => undefined);
        await node.stop();
        this.node = null;
    }

    async fetchArtifact(
        manifest: LargeTransferManifest,
        options: DownloadSandboxOptions = {}
    ): Promise<DownloadedArtifact> {
        const node = this.requireNode();
        const address = selectLibp2pAddress(manifest);
        const timeoutMs = options.timeoutMs ?? this.defaultOptions.transferTimeoutMs ?? 300_000;
        const stream = await node.dialProtocol(
            multiaddr(normalizeLibp2pAddress(address)),
            ENVOQ_LIBP2P_TRANSFER_PROTOCOL,
            { signal: AbortSignal.timeout(timeoutMs), runOnLimitedConnection: true }
        );
        const reader = new StreamByteReader(stream);
        const token = manifest.metadata?.access_token;
        const request: ArtifactRequest = {
            type: 'get_artifact',
            transfer_id: manifest.transfer_id
        };
        if (typeof token === 'string' && token.length > 0) {
            request.access_token = token;
        }
        await sendStreamMessage(stream, encodeControlFrame(request), timeoutMs);

        const header = await reader.readControlFrame<ArtifactHeader>(timeoutMs);
        if (header.type !== 'artifact_metadata') {
            throw new Error('Libp2p transfer did not return artifact metadata');
        }
        if (
            header.transfer_id !== manifest.transfer_id
            || header.size_bytes !== manifest.size_bytes
            || header.sha256.toLowerCase() !== manifest.sha256.toLowerCase()
        ) {
            throw new Error('Libp2p artifact metadata did not match manifest');
        }

        const targetDir = sandboxPath(options.sandboxRoot ?? defaultSandboxRoot(), manifest);
        await mkdir(targetDir, { recursive: true });
        const targetPath = path.join(targetDir, metadataFileName(manifest));
        const tempPath = `${targetPath}.${process.pid}.libp2p.part`;
        const output = createWriteStream(tempPath, { flags: 'wx' });
        const hash = crypto.createHash('sha256');
        let sizeBytes = 0;

        try {
            for await (const buffer of reader.readRemaining(timeoutMs)) {
                sizeBytes += buffer.length;
                if (sizeBytes > manifest.size_bytes) {
                    throw new Error('Libp2p artifact exceeded manifest size_bytes while downloading');
                }
                hash.update(buffer);
                if (!output.write(buffer)) {
                    await once(output, 'drain');
                }
            }
            output.end();
            await once(output, 'finish');

            if (sizeBytes !== manifest.size_bytes) {
                throw new Error('Libp2p artifact byte count did not match manifest size_bytes');
            }
            const sha256 = hash.digest('hex');
            if (sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
                throw new Error('Libp2p artifact sha256 did not match manifest checksum');
            }

            await rename(tempPath, targetPath);
            await stream.close().catch(() => undefined);
            return {
                transfer_id: manifest.transfer_id,
                file_path: targetPath,
                sha256,
                size_bytes: sizeBytes,
                verified: true,
                source_url: address
            };
        } catch (error) {
            output.destroy();
            await rm(tempPath, { force: true }).catch(() => undefined);
            stream.abort(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    private requireNode(): Libp2p {
        if (!this.node || this.node.status !== 'started') {
            throw new Error('Libp2p transfer transport is not running');
        }
        return this.node;
    }

    private async dialRelay(relay: string, timeoutMs: number): Promise<void> {
        const node = this.requireNode();
        await node.dial(multiaddr(relay), {
            signal: AbortSignal.timeout(timeoutMs)
        });
    }

    private async handleIncomingStream(stream: Stream): Promise<void> {
        const reader = new StreamByteReader(stream);
        const request = await reader.readControlFrame<ArtifactRequest>(30_000);
        if (request.type !== 'get_artifact') {
            throw new Error('Unsupported libp2p transfer request type');
        }

        const record = await this.store.getTransfer(request.transfer_id);
        if (!record || record.role !== 'sender' || !record.local_path) {
            throw new Error('Transfer not found on sender sidecar');
        }

        const expectedToken = transferAccessToken(record);
        if (
            !expectedToken
            || typeof request.access_token !== 'string'
            || !timingSafeStringEqual(request.access_token, expectedToken)
        ) {
            throw new Error('Invalid libp2p transfer access token');
        }

        const fileStats = await stat(record.local_path);
        if (!fileStats.isFile() || fileStats.size !== record.manifest.size_bytes) {
            throw new Error('Local artifact is unavailable or no longer matches manifest size');
        }

        const header: ArtifactHeader = {
            type: 'artifact_metadata',
            transfer_id: record.transfer_id,
            size_bytes: record.manifest.size_bytes,
            sha256: record.manifest.sha256,
            content_type: record.manifest.content_type
        };
        if (typeof record.manifest.metadata?.file_name === 'string') {
            header.file_name = record.manifest.metadata.file_name;
        }
        await sendStreamMessage(stream, encodeControlFrame(header), 30_000);

        const input = createReadStream(record.local_path, { highWaterMark: this.chunkBytes });
        for await (const chunk of input) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            await sendStreamMessage(stream, buffer, 30_000);
        }
        await stream.close();
    }
}
