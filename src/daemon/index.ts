import { loadEnvoqEnv } from '../config/env.js';
import { EnvoqSidecar } from '../sidecar/transfers.js';
import { debugLog } from '../utils/debug.js';
import { isDirectEntrypoint } from '../utils/entrypoint.js';
import { startDaemonControlServer, type DaemonControlServer } from './control.js';

loadEnvoqEnv();

const ENVOQ_HUB_URL = process.env.ENVOQ_HUB_URL || 'https://api.envoq.tech/api/v1';
const HUB_SECRET = process.env.HUB_SECRET;
const AGENT_ID = process.env.AGENT_ID;
let controlServer: DaemonControlServer | null = null;

if (!HUB_SECRET || !AGENT_ID) {
    console.error('FATAL: HUB_SECRET and AGENT_ID environment variables are required to start the Envoq daemon.');
    process.exit(1);
}

const sidecar = new EnvoqSidecar({
    hubUrl: ENVOQ_HUB_URL,
    hubSecret: HUB_SECRET,
    agentId: AGENT_ID
});

let stopping = false;
let keepAlive: NodeJS.Timeout | null = null;

function httpStatusFromError(err: unknown): number | undefined {
    const record = err && typeof err === 'object' ? err as Record<string, unknown> : {};
    if (typeof record.httpStatus === 'number') return record.httpStatus;
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/status(?: code)?\s+(\d{3})|HTTP\s+(\d{3})/i);
    const status = match?.[1] ?? match?.[2];
    return status ? Number(status) : undefined;
}

function tunnelStartFailureMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const status = httpStatusFromError(err);
    if (status === 402) {
        return 'Reverse tunnel unavailable: HTTP 402 Payment Required. Retrying with slow backoff in the background.';
    }
    if (status === 403) {
        return 'Reverse tunnel unavailable: HTTP 403 Forbidden. Retrying with slow backoff in the background.';
    }
    return `Reverse tunnel start failed; reconnect will continue in the background when possible: ${message}`;
}

async function stop(signal: NodeJS.Signals): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.error(`[Envoq Daemon] Received ${signal}; stopping.`);
    sidecar.stopTunnel();
    try {
        await controlServer?.close();
    } catch (error) {
        debugLog('Failed to close daemon control server', {
            message: error instanceof Error ? error.message : String(error)
        });
    }
    if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
    }
    process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

export async function main(_argv: string[] = process.argv.slice(2)): Promise<void> {
    console.error(`[Envoq Daemon] Starting reverse tunnel for Agent ID: ${AGENT_ID}`);
    debugLog('Daemon runtime configuration', {
        hub_url: ENVOQ_HUB_URL,
        agent_id: AGENT_ID
    });

    keepAlive = setInterval(() => undefined, 60_000);
    controlServer = await startDaemonControlServer(sidecar);
    console.error(`[Envoq Daemon] Local control socket ready on 127.0.0.1:${controlServer.port}`);

    await sidecar.startTunnel()
        .then((status) => {
            console.error(`[Envoq Daemon] Reverse tunnel connected for tenant ${status.tenant_id ?? 'unknown'}`);
        })
        .catch((err) => {
            console.error(`[Envoq Daemon] ${tunnelStartFailureMessage(err)}`);
            debugLog('Daemon reverse tunnel startup failure', {
                message: err instanceof Error ? err.message : String(err),
                http_status: httpStatusFromError(err)
            });
        });
}

if (process.env.ENVOQ_CLI_DISPATCH !== '1' && isDirectEntrypoint(import.meta.url)) {
    main().catch((err) => {
        console.error('Fatal Envoq daemon error:', err);
        process.exit(1);
    });
}
