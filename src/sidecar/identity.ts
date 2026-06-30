import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SidecarIdentity {
    agentId: string;
    publicKey: string;
    privateKeyPem: string;
    privateKey: crypto.KeyObject;
}

interface SidecarIdentityFile {
    agent_id: string;
    public_key: string;
    private_key_pem: string;
    created_at: string;
}

function safeAgentId(agentId: string): string {
    return agentId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'agent';
}

export function defaultIdentityPath(agentId: string): string {
    return process.env.ENVOQ_SIDECAR_IDENTITY_PATH
        || path.join(os.homedir(), '.envoq', 'identities', `${safeAgentId(agentId)}.json`);
}

function publicKeyToRawBase64(publicKey: crypto.KeyObject): string {
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
    if (typeof jwk.x !== 'string' || jwk.x.length === 0) {
        throw new Error('Generated Ed25519 public key did not expose a raw JWK x coordinate');
    }
    return Buffer.from(jwk.x, 'base64url').toString('base64');
}

function parseIdentity(raw: string, filePath: string): SidecarIdentityFile {
    const parsed = JSON.parse(raw) as Partial<SidecarIdentityFile>;
    if (
        typeof parsed.agent_id !== 'string'
        || typeof parsed.public_key !== 'string'
        || typeof parsed.private_key_pem !== 'string'
    ) {
        throw new Error(`Invalid Envoq sidecar identity file: ${filePath}`);
    }
    return {
        agent_id: parsed.agent_id,
        public_key: parsed.public_key,
        private_key_pem: parsed.private_key_pem,
        created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString()
    };
}

async function writeIdentityFile(filePath: string, identity: SidecarIdentityFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, filePath);
    await chmod(filePath, 0o600);
}

export async function loadOrCreateSidecarIdentity(agentId: string, identityPath = defaultIdentityPath(agentId)): Promise<SidecarIdentity> {
    try {
        const identity = parseIdentity(await readFile(identityPath, 'utf8'), identityPath);
        if (identity.agent_id !== agentId) {
            throw new Error(`Identity file ${identityPath} belongs to ${identity.agent_id}, not ${agentId}`);
        }
        return {
            agentId,
            publicKey: identity.public_key,
            privateKeyPem: identity.private_key_pem,
            privateKey: crypto.createPrivateKey(identity.private_key_pem)
        };
    } catch (err: any) {
        if (err?.code !== 'ENOENT') {
            throw err;
        }
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const identityFile: SidecarIdentityFile = {
        agent_id: agentId,
        public_key: publicKeyToRawBase64(publicKey),
        private_key_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        created_at: new Date().toISOString()
    };
    await writeIdentityFile(identityPath, identityFile);

    return {
        agentId,
        publicKey: identityFile.public_key,
        privateKeyPem: identityFile.private_key_pem,
        privateKey
    };
}

export function signTunnelHandshake(agentId: string, timestamp: string, privateKey: crypto.KeyObject): string {
    return crypto.sign(null, Buffer.from(`${agentId}.${timestamp}`), privateKey).toString('hex');
}
