import { copyFile, mkdir, rm } from 'fs/promises';
import path from 'path';

export interface CloudUploadInput {
    localPath: string;
    transferId: string;
    revision: number;
    fileName?: string;
}

export interface CloudUploadResult {
    url: string;
    storage_key: string;
    provider: string;
}

export interface CloudStorageAdapter {
    upload(input: CloudUploadInput): Promise<CloudUploadResult>;
    delete(storageKey: string): Promise<void>;
}

function defaultCloudRoot(): string {
    return process.env.ENVOQ_CLOUD_FS_ROOT
        || path.join(process.cwd(), '.envoq_sidecar', 'cloud');
}

function defaultPublicBaseUrl(): string {
    return (process.env.ENVOQ_CLOUD_PUBLIC_BASE_URL || 'https://artifact-store.internal/envoq').replace(/\/+$/, '');
}

function safeSegment(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'artifact';
}

function ensureInsideRoot(root: string, candidate: string): string {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(resolvedRoot, candidate);
    if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error('Cloud storage key escaped the configured root');
    }
    return resolvedCandidate;
}

function joinUrl(baseUrl: string, segments: string[]): string {
    const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
    return `${baseUrl}/${encoded}`;
}

export class FileSystemCloudStorageAdapter implements CloudStorageAdapter {
    public readonly provider = 'filesystem';
    private readonly rootDir: string;
    private readonly publicBaseUrl: string;

    constructor(
        rootDir: string = defaultCloudRoot(),
        publicBaseUrl: string = defaultPublicBaseUrl()
    ) {
        this.rootDir = rootDir;
        this.publicBaseUrl = publicBaseUrl;
    }

    async upload(input: CloudUploadInput): Promise<CloudUploadResult> {
        const fileName = safeSegment(input.fileName ?? path.basename(input.localPath));
        const segments = [
            safeSegment(input.transferId),
            `rev-${input.revision}`,
            fileName
        ];
        const storageKey = segments.join('/');
        const targetPath = ensureInsideRoot(this.rootDir, storageKey);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(input.localPath, targetPath);
        return {
            url: joinUrl(this.publicBaseUrl, segments),
            storage_key: storageKey,
            provider: this.provider
        };
    }

    async delete(storageKey: string): Promise<void> {
        const targetPath = ensureInsideRoot(this.rootDir, storageKey);
        await rm(targetPath, { force: true });
    }
}
