import type { LargeTransferManifest } from './manifest.ts';

export type TransferTransportKind = 'libp2p' | 'http' | 'cloud' | 'unknown';

export interface TransferTransportAddress {
    kind: TransferTransportKind;
    address: string;
    priority: number;
}

export function classifyTransportAddress(address: string): TransferTransportAddress {
    if (address.startsWith('libp2p:') || address.startsWith('/ip4/') || address.startsWith('/ip6/') || address.startsWith('/dns4/') || address.startsWith('/dns6/') || address.startsWith('/dnsaddr/')) {
        return { kind: 'libp2p', address, priority: 10 };
    }
    if (address.startsWith('http://') || address.startsWith('https://')) {
        return address.includes('artifact-store.internal') || address.includes('storage.internal')
            ? { kind: 'cloud', address, priority: 30 }
            : { kind: 'http', address, priority: 20 };
    }
    return { kind: 'unknown', address, priority: 100 };
}

export function orderedTransportAddresses(manifest: LargeTransferManifest): TransferTransportAddress[] {
    return manifest.transport_addresses
        .map(classifyTransportAddress)
        .sort((left, right) => left.priority - right.priority);
}

export function hasTransportKind(manifest: LargeTransferManifest, kind: TransferTransportKind): boolean {
    return orderedTransportAddresses(manifest).some((entry) => entry.kind === kind);
}
