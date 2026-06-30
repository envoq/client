import crypto from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { FileSystemCloudStorageAdapter, type CloudStorageAdapter, type CloudUploadInput, type CloudUploadResult } from './cloud.ts';

interface S3CompatibleAdapterConfig {
    provider: string;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string | undefined;
    publicBaseUrl?: string | undefined;
    forcePathStyle?: boolean;
}

interface SignedRequest {
    url: URL;
    headers: Record<string, string>;
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name];
    return value && value.length > 0 ? value : undefined;
}

function boolEnv(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value === undefined) {
        return fallback;
    }
    return value === 'true';
}

function safeSegment(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'artifact';
}

function storageKey(input: CloudUploadInput): string {
    return [
        safeSegment(input.transferId),
        `rev-${input.revision}`,
        safeSegment(input.fileName ?? path.basename(input.localPath))
    ].join('/');
}

function encodePathSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectKey(key: string): string {
    return key.split('/').map(encodePathSegment).join('/');
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string): Buffer {
    return crypto.createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = createReadStream(filePath);
        input.on('error', reject);
        input.on('data', (chunk) => {
            hash.update(chunk);
        });
        input.on('end', () => resolve(hash.digest('hex')));
    });
}

function yyyymmdd(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function amzDate(date: Date): string {
    return `${yyyymmdd(date)}T${date.toISOString().slice(11, 19).replace(/:/g, '')}Z`;
}

function joinPublicUrl(baseUrl: string, key: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${encodeObjectKey(key)}`;
}

export class S3CompatibleCloudStorageAdapter implements CloudStorageAdapter {
    public readonly provider: string;
    private readonly endpoint: string;
    private readonly region: string;
    private readonly bucket: string;
    private readonly accessKeyId: string;
    private readonly secretAccessKey: string;
    private readonly sessionToken: string | undefined;
    private readonly publicBaseUrl: string | undefined;
    private readonly forcePathStyle: boolean;

    constructor(config: S3CompatibleAdapterConfig) {
        this.provider = config.provider;
        this.endpoint = config.endpoint.replace(/\/+$/, '');
        this.region = config.region;
        this.bucket = config.bucket;
        this.accessKeyId = config.accessKeyId;
        this.secretAccessKey = config.secretAccessKey;
        this.sessionToken = config.sessionToken;
        this.publicBaseUrl = config.publicBaseUrl;
        this.forcePathStyle = config.forcePathStyle ?? false;
    }

    async upload(input: CloudUploadInput): Promise<CloudUploadResult> {
        const key = storageKey(input);
        const fileStats = await stat(input.localPath);
        if (!fileStats.isFile()) {
            throw new Error('Cloud upload path must point to a regular file');
        }
        const payloadHash = await hashFile(input.localPath);
        const signed = this.signRequest('PUT', key, payloadHash, {
            'content-length': fileStats.size.toString()
        });
        const response = await fetch(signed.url, {
            method: 'PUT',
            headers: signed.headers,
            body: createReadStream(input.localPath) as unknown as BodyInit,
            duplex: 'half'
        } as RequestInit);
        if (!response.ok) {
            throw new Error(`${this.provider} upload failed with ${response.status}: ${await response.text()}`);
        }
        return {
            provider: this.provider,
            storage_key: key,
            url: this.publicBaseUrl ? joinPublicUrl(this.publicBaseUrl, key) : this.objectUrl(key).toString()
        };
    }

    async delete(storageKey: string): Promise<void> {
        const signed = this.signRequest('DELETE', storageKey, sha256Hex(''), {});
        const response = await fetch(signed.url, {
            method: 'DELETE',
            headers: signed.headers
        });
        if (!response.ok && response.status !== 404) {
            throw new Error(`${this.provider} delete failed with ${response.status}: ${await response.text()}`);
        }
    }

    private objectUrl(key: string): URL {
        const endpointUrl = new URL(this.endpoint);
        const encodedKey = encodeObjectKey(key);
        if (this.forcePathStyle) {
            endpointUrl.pathname = `${endpointUrl.pathname.replace(/\/+$/, '')}/${encodePathSegment(this.bucket)}/${encodedKey}`;
            return endpointUrl;
        }
        endpointUrl.hostname = `${this.bucket}.${endpointUrl.hostname}`;
        endpointUrl.pathname = `${endpointUrl.pathname.replace(/\/+$/, '')}/${encodedKey}`;
        return endpointUrl;
    }

    private signRequest(method: string, key: string, payloadHash: string, extraHeaders: Record<string, string>): SignedRequest {
        const now = new Date();
        const date = yyyymmdd(now);
        const timestamp = amzDate(now);
        const url = this.objectUrl(key);
        const headers: Record<string, string> = {
            host: url.host,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': timestamp,
            ...extraHeaders
        };
        if (this.sessionToken) {
            headers['x-amz-security-token'] = this.sessionToken;
        }

        const signedHeaderNames = Object.keys(headers).sort();
        const canonicalHeaders = signedHeaderNames
            .map((header) => `${header}:${headers[header]?.trim() ?? ''}\n`)
            .join('');
        const credentialScope = `${date}/${this.region}/s3/aws4_request`;
        const canonicalRequest = [
            method,
            url.pathname || '/',
            url.searchParams.toString(),
            canonicalHeaders,
            signedHeaderNames.join(';'),
            payloadHash
        ].join('\n');
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            timestamp,
            credentialScope,
            sha256Hex(canonicalRequest)
        ].join('\n');
        const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, date), this.region), 's3'), 'aws4_request');
        const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
        headers.authorization = [
            `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}`,
            `SignedHeaders=${signedHeaderNames.join(';')}`,
            `Signature=${signature}`
        ].join(', ');
        return { url, headers };
    }
}

export class GcsCloudStorageAdapter implements CloudStorageAdapter {
    public readonly provider = 'gcs';
    private readonly bucket: string;
    private readonly accessToken: string;
    private readonly publicBaseUrl: string;

    constructor(config: { bucket: string; accessToken: string; publicBaseUrl?: string | undefined }) {
        this.bucket = config.bucket;
        this.accessToken = config.accessToken;
        this.publicBaseUrl = config.publicBaseUrl ?? `https://storage.googleapis.com/${config.bucket}`;
    }

    async upload(input: CloudUploadInput): Promise<CloudUploadResult> {
        const key = storageKey(input);
        const fileStats = await stat(input.localPath);
        if (!fileStats.isFile()) {
            throw new Error('Cloud upload path must point to a regular file');
        }
        const uploadUrl = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
        uploadUrl.searchParams.set('uploadType', 'media');
        uploadUrl.searchParams.set('name', key);
        const response = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.accessToken}`,
                'content-length': fileStats.size.toString()
            },
            body: createReadStream(input.localPath) as unknown as BodyInit,
            duplex: 'half'
        } as RequestInit);
        if (!response.ok) {
            throw new Error(`GCS upload failed with ${response.status}: ${await response.text()}`);
        }
        return {
            provider: this.provider,
            storage_key: key,
            url: joinPublicUrl(this.publicBaseUrl, key)
        };
    }

    async delete(storageKey: string): Promise<void> {
        const deleteUrl = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(storageKey)}`);
        const response = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: {
                authorization: `Bearer ${this.accessToken}`
            }
        });
        if (!response.ok && response.status !== 404) {
            throw new Error(`GCS delete failed with ${response.status}: ${await response.text()}`);
        }
    }
}

export function createCloudStorageAdapterFromEnv(): CloudStorageAdapter {
    const provider = (process.env.ENVOQ_CLOUD_PROVIDER || 'filesystem').toLowerCase();
    if (provider === 'filesystem' || provider === 'fs') {
        return new FileSystemCloudStorageAdapter();
    }
    if (provider === 's3') {
        const region = requiredEnv('ENVOQ_S3_REGION');
        return new S3CompatibleCloudStorageAdapter({
            provider: 's3',
            endpoint: optionalEnv('ENVOQ_S3_ENDPOINT') ?? `https://s3.${region}.amazonaws.com`,
            region,
            bucket: requiredEnv('ENVOQ_S3_BUCKET'),
            accessKeyId: requiredEnv('ENVOQ_S3_ACCESS_KEY_ID'),
            secretAccessKey: requiredEnv('ENVOQ_S3_SECRET_ACCESS_KEY'),
            sessionToken: optionalEnv('ENVOQ_S3_SESSION_TOKEN'),
            publicBaseUrl: optionalEnv('ENVOQ_S3_PUBLIC_BASE_URL'),
            forcePathStyle: boolEnv('ENVOQ_S3_FORCE_PATH_STYLE', false)
        });
    }
    if (provider === 'r2') {
        const accountId = requiredEnv('ENVOQ_R2_ACCOUNT_ID');
        return new S3CompatibleCloudStorageAdapter({
            provider: 'r2',
            endpoint: optionalEnv('ENVOQ_R2_ENDPOINT') ?? `https://${accountId}.r2.cloudflarestorage.com`,
            region: optionalEnv('ENVOQ_R2_REGION') ?? 'auto',
            bucket: requiredEnv('ENVOQ_R2_BUCKET'),
            accessKeyId: requiredEnv('ENVOQ_R2_ACCESS_KEY_ID'),
            secretAccessKey: requiredEnv('ENVOQ_R2_SECRET_ACCESS_KEY'),
            publicBaseUrl: optionalEnv('ENVOQ_R2_PUBLIC_BASE_URL'),
            forcePathStyle: boolEnv('ENVOQ_R2_FORCE_PATH_STYLE', true)
        });
    }
    if (provider === 'gcs') {
        return new GcsCloudStorageAdapter({
            bucket: requiredEnv('ENVOQ_GCS_BUCKET'),
            accessToken: requiredEnv('ENVOQ_GCS_ACCESS_TOKEN'),
            publicBaseUrl: optionalEnv('ENVOQ_GCS_PUBLIC_BASE_URL')
        });
    }
    throw new Error(`Unsupported ENVOQ_CLOUD_PROVIDER: ${provider}`);
}
