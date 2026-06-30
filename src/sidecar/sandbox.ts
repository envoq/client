import crypto from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rename, rm } from 'fs/promises';
import path from 'path';
import { once } from 'events';
import { Readable } from 'stream';
import type { LargeTransferManifest } from './manifest.ts';

export interface DownloadSandboxOptions {
    sandboxRoot?: string;
    timeoutMs?: number;
}

export interface DownloadedArtifact {
    transfer_id: string;
    file_path: string;
    sha256: string;
    size_bytes: number;
    verified: true;
    source_url: string;
}

function defaultSandboxRoot(): string {
    return process.env.ENVOQ_SIDECAR_SANDBOX_DIR
        || path.join(process.cwd(), '.envoq_sidecar', 'sandbox');
}

function safeSegment(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'artifact';
}

function selectFetchUrl(manifest: LargeTransferManifest): URL {
    for (const address of manifest.transport_addresses) {
        try {
            const url = new URL(address);
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                return url;
            }
        } catch {
            continue;
        }
    }
    throw new Error('Manifest does not contain an HTTP(S) transfer address supported by this sidecar');
}

function sandboxPath(root: string, manifest: LargeTransferManifest): string {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(
        resolvedRoot,
        safeSegment(manifest.transfer_id),
        `rev-${manifest.revision}`
    );
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error('Resolved sandbox path escaped the configured sandbox root');
    }
    return resolvedPath;
}

function artifactName(url: URL, manifest: LargeTransferManifest): string {
    const metadataName = manifest.metadata?.file_name;
    if (typeof metadataName === 'string' && metadataName.length > 0) {
        return safeSegment(metadataName);
    }
    const fromUrl = path.basename(url.pathname);
    return safeSegment(fromUrl || `${manifest.transfer_id}.artifact`);
}

export async function downloadManifestArtifact(
    manifest: LargeTransferManifest,
    options: DownloadSandboxOptions = {}
): Promise<DownloadedArtifact> {
    const sourceUrl = selectFetchUrl(manifest);
    const root = options.sandboxRoot ?? defaultSandboxRoot();
    const targetDir = sandboxPath(root, manifest);
    await mkdir(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, artifactName(sourceUrl, manifest));
    const tempPath = `${targetPath}.${process.pid}.part`;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {};
    const token = manifest.metadata?.access_token;
    if (typeof token === 'string' && token.length > 0) {
        headers['x-envoq-transfer-token'] = token;
    }

    try {
        const response = await fetch(sourceUrl, {
            headers,
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`Artifact fetch failed with HTTP ${response.status}`);
        }
        if (!response.body) {
            throw new Error('Artifact fetch response did not include a body');
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && Number.parseInt(contentLength, 10) !== manifest.size_bytes) {
            throw new Error('Artifact content-length did not match manifest size_bytes');
        }

        const hash = crypto.createHash('sha256');
        let sizeBytes = 0;
        const output = createWriteStream(tempPath, { flags: 'wx' });
        const input = Readable.fromWeb(response.body as any);

        try {
            for await (const chunk of input) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                sizeBytes += buffer.length;
                if (sizeBytes > manifest.size_bytes) {
                    throw new Error('Artifact exceeded manifest size_bytes while downloading');
                }
                hash.update(buffer);
                if (!output.write(buffer)) {
                    await once(output, 'drain');
                }
            }
            output.end();
            await once(output, 'finish');
        } catch (error) {
            output.destroy();
            throw error;
        }

        if (sizeBytes !== manifest.size_bytes) {
            throw new Error('Artifact byte count did not match manifest size_bytes');
        }

        const sha256 = hash.digest('hex');
        if (sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
            throw new Error('Artifact sha256 did not match manifest checksum');
        }

        await rename(tempPath, targetPath);
        return {
            transfer_id: manifest.transfer_id,
            file_path: targetPath,
            sha256,
            size_bytes: sizeBytes,
            verified: true,
            source_url: sourceUrl.toString()
        };
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
