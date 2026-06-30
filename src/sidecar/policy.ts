import axios from 'axios';
import {
    AGENT_ONBOARDING_POLICY_BUNDLE,
    LARGE_PAYLOAD_POLICY
} from '../policies/onboarding.ts';
import type { LargeTransferManifest } from './manifest.ts';
import { validateLargeTransferManifest } from './manifest.ts';

export type PolicyBundle = typeof AGENT_ONBOARDING_POLICY_BUNDLE;

interface CachedPolicy {
    bundle: PolicyBundle;
    fetchedAt: number;
    source: 'hub' | 'local_fallback';
}

let cachedPolicy: CachedPolicy | null = null;

function normalizeHubUrl(hubUrl: string): string {
    return hubUrl.replace(/\/+$/, '');
}

export async function fetchPolicyBundleFromHub(hubUrl: string): Promise<CachedPolicy> {
    try {
        const response = await axios.get(`${normalizeHubUrl(hubUrl)}/policy`, { timeout: 2500 });
        const data = response.data as Partial<PolicyBundle>;
        if (!data.security_policy || !data.large_payload_policy) {
            throw new Error('Policy response missing required policy objects');
        }
        return {
            bundle: data as PolicyBundle,
            fetchedAt: Date.now(),
            source: 'hub'
        };
    } catch {
        return {
            bundle: AGENT_ONBOARDING_POLICY_BUNDLE,
            fetchedAt: Date.now(),
            source: 'local_fallback'
        };
    }
}

export async function getPolicyBundle(options: {
    hubUrl: string;
    forceRefresh?: boolean;
    ttlMs?: number;
    policyBundle?: PolicyBundle;
}): Promise<CachedPolicy> {
    if (options.policyBundle && !options.forceRefresh) {
        return {
            bundle: options.policyBundle,
            fetchedAt: Date.now(),
            source: 'local_fallback'
        };
    }

    const ttlMs = options.ttlMs ?? 60_000;
    if (
        cachedPolicy
        && !options.forceRefresh
        && Date.now() - cachedPolicy.fetchedAt < ttlMs
    ) {
        return cachedPolicy;
    }

    cachedPolicy = await fetchPolicyBundleFromHub(options.hubUrl);
    return cachedPolicy;
}

export function estimateInlinePayloadBytes(payload: unknown): number {
    return Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
}

export function assertInlinePayloadAllowed(
    payload: unknown,
    policy = LARGE_PAYLOAD_POLICY
): void {
    const bytes = estimateInlinePayloadBytes(payload);
    if (bytes > policy.max_inline_payload_bytes) {
        throw new Error(`Payload is ${bytes} bytes; Envoq inline payload limit is ${policy.max_inline_payload_bytes} bytes`);
    }
}

export function enforceLargeTransferManifest(
    manifest: LargeTransferManifest,
    policy = LARGE_PAYLOAD_POLICY
): void {
    const validation = validateLargeTransferManifest(manifest, policy);
    if (!validation.valid) {
        throw new Error(`Invalid large transfer manifest: ${validation.errors.join('; ')}`);
    }
}
