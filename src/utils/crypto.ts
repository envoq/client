import crypto from 'crypto';

/**
 * Enterprise Security: HMAC-SHA256 Signature Generation
 * The Hub uses this to sign payloads before delivering them to agents.
 * This ensures the agent can verify the payload actually came from the Hub and wasn't spoofed.
 */
export function generateHmacSignature(payload: string | Buffer, timestamp: string, nonce: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(timestamp);
    hmac.update(nonce);
    hmac.update(payload);
    return hmac.digest('hex');
}

/**
 * Verifies an incoming HMAC signature
 */
export function verifyHmacSignature(payload: string | Buffer, timestamp: string, nonce: string, signature: string, secret: string): boolean {
    const expectedSignature = generateHmacSignature(payload, timestamp, nonce, secret);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    
    if (sigBuf.length !== expBuf.length) {
        return false;
    }
    
    try {
        return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch (e) {
        return false;
    }
}

/**
 * Verifies an agent's Ed25519 signature using the context string `AgentID + '.' + Timestamp`
 */
export function verifyEd25519Signature(
    agentId: string,
    timestamp: string,
    signature: string,
    publicKeyBuffer: Buffer
): boolean {
    try {
        const message = Buffer.from(agentId + '.' + timestamp);
        let signatureBuffer: Buffer;
        if (/^[0-9a-fA-F]{128}$/.test(signature)) {
            signatureBuffer = Buffer.from(signature, 'hex');
        } else {
            signatureBuffer = Buffer.from(signature, 'base64');
        }

        const jwk = {
            kty: 'OKP',
            crv: 'Ed25519',
            x: publicKeyBuffer.toString('base64url')
        };
        const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        return crypto.verify(null, message, keyObject, signatureBuffer);
    } catch (e) {
        return false;
    }
}

export function parseEd25519PublicKey(rawKey: Buffer): Buffer {
    const rawKeyString = rawKey.toString('utf8');

    if (rawKey.length === 64 && /^[0-9a-fA-F]{64}$/.test(rawKeyString)) {
        return Buffer.from(rawKeyString, 'hex');
    }

    if (rawKey.length === 32) {
        return rawKey;
    }

    if (/^[0-9a-fA-F]{64}$/.test(rawKeyString)) {
        return Buffer.from(rawKeyString, 'hex');
    }

    return Buffer.from(rawKeyString, 'base64');
}
