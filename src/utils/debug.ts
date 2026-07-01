const SECRET_KEY_PATTERN = /(secret|token|key|authorization|password)/i;

export function isDebugEnabled(): boolean {
    const value = process.env.ENVOQ_DEBUG ?? process.env.DEBUG;
    return value === '1' || value === 'true' || value === 'envoq' || value === 'envoq:*';
}

function maskString(value: string): string {
    if (value.length <= 8) return '<redacted>';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function sanitizeDebugValue(value: unknown, key = ''): unknown {
    if (typeof value === 'string') {
        return SECRET_KEY_PATTERN.test(key) ? maskString(value) : value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeDebugValue(entry));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
            entryKey,
            sanitizeDebugValue(entryValue, entryKey)
        ])
    );
}

export function debugLog(message: string, details?: unknown): void {
    if (!isDebugEnabled()) return;
    if (details === undefined) {
        console.error(`[Envoq debug] ${message}`);
        return;
    }
    console.error(`[Envoq debug] ${message}: ${JSON.stringify(sanitizeDebugValue(details), null, 2)}`);
}
