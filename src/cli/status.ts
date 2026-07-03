import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { envoqConfigDir, loadEnvoqEnv } from '../config/env.ts';
import { debugLog, isDebugEnabled } from '../utils/debug.ts';

loadEnvoqEnv();

interface BillingStatusResponse {
    tenant_id?: string;
    plan?: string;
    plan_label?: string;
    status?: string;
    billing_status?: string;
    tunnel_allowed?: boolean;
    credit_limit?: number;
    current_spend?: number;
    remaining_balance?: number;
    alert_message?: string | null;
    billing?: {
        status?: string;
        tunnel_allowed?: boolean;
        credit_limit?: number;
        current_spend?: number;
        remaining_balance?: number;
        alert_message?: string | null;
    };
}

interface DaemonControlFile {
    host?: string;
    port?: number;
    token?: string;
    pid?: number;
}

export interface PrintStatusOptions {
    packageRoot: string;
    refreshBilling?: boolean;
}

function joinUrl(base: string, urlPath: string): string {
    const cleanBase = base.replace(/\/+$/, '');
    const cleanPath = urlPath.replace(/^\/+/, '');
    return `${cleanBase}/${cleanPath}`;
}

function displayPlan(value: string | undefined): string {
    if (!value) return 'Unknown';
    return value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
        .join(' ');
}

async function responseText(response: Response): Promise<string> {
    return await response.text().catch((error) => `Unable to read response body: ${error.message}`);
}

function daemonControlPath(): string {
    return path.join(envoqConfigDir(), 'daemon-control.json');
}

async function readDaemonControlFile(): Promise<DaemonControlFile | null> {
    try {
        const raw = await readFile(daemonControlPath(), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed as DaemonControlFile;
    } catch {
        return null;
    }
}

async function requestDaemonRefresh(): Promise<'not_running' | 'refreshed' | 'failed'> {
    const control = await readDaemonControlFile();
    if (!control?.port || !control.token) {
        return 'not_running';
    }

    const host = control.host || '127.0.0.1';
    const url = `http://${host}:${control.port}/refresh`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${control.token}`
            }
        });
        if (!response.ok) {
            debugLog('Daemon refresh request failed', {
                url,
                status: response.status,
                body: await responseText(response)
            });
            return 'failed';
        }
        return 'refreshed';
    } catch (error) {
        debugLog('Daemon refresh request failed', {
            url,
            message: error instanceof Error ? error.message : String(error)
        });
        return 'failed';
    }
}

async function fetchBillingStatus(hubUrl: string, hubSecret: string, refresh: boolean): Promise<BillingStatusResponse | null> {
    const url = joinUrl(hubUrl, refresh ? 'billing/refresh' : 'billing/status');
    try {
        const response = await fetch(url, {
            method: refresh ? 'POST' : 'GET',
            headers: {
                Authorization: `Bearer ${hubSecret}`,
                'Content-Type': 'application/json'
            }
        });
        const body = await responseText(response);
        if (isDebugEnabled()) {
            console.error(`[Envoq debug] billing ${refresh ? 'refresh' : 'status'} url: ${url}`);
            console.error(`[Envoq debug] billing ${refresh ? 'refresh' : 'status'} status: HTTP ${response.status}`);
            if (body) {
                console.error(`[Envoq debug] billing ${refresh ? 'refresh' : 'status'} body: ${body.slice(0, 4096)}`);
            }
        }
        if (!response.ok) {
            console.log(`- plan: unavailable (HTTP ${response.status})`);
            return null;
        }
        return JSON.parse(body) as BillingStatusResponse;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`- plan: unavailable (${message})`);
        debugLog('billing status request failed', {
            url,
            message,
            stack: error instanceof Error ? error.stack : undefined
        });
        return null;
    }
}

function printBillingStatus(status: BillingStatusResponse | null): void {
    if (!status) return;
    const plan = status.plan_label || displayPlan(status.plan);
    const billing = status.billing ?? {};
    const billingStatus = status.billing_status || status.status || billing.status || 'unknown';
    const tunnelAllowed = status.tunnel_allowed ?? billing.tunnel_allowed;

    console.log(`- plan: ${plan}`);
    console.log(`- billing status: ${billingStatus}`);
    if (tunnelAllowed !== undefined) {
        console.log(`- tunnel allowed: ${tunnelAllowed ? 'yes' : 'no'}`);
    }
    const remaining = status.remaining_balance ?? billing.remaining_balance;
    if (typeof remaining === 'number' && Number.isFinite(remaining)) {
        console.log(`- remaining balance: ${remaining}`);
    }
    const alertMessage = status.alert_message ?? billing.alert_message;
    if (alertMessage) {
        console.log(`- alert: ${alertMessage}`);
    }
}

export async function printStatus(options: PrintStatusOptions): Promise<void> {
    const hubUrl = process.env.ENVOQ_HUB_URL || 'https://api.envoq.tech/api/v1';
    const healthUrl = joinUrl(hubUrl, 'health');
    const hubSecret = process.env.HUB_SECRET || process.env.ENVOQ_API_KEY || '';

    await mkdir(envoqConfigDir(), { recursive: true, mode: 0o700 }).catch(() => undefined);

    console.log('Envoq CLI status');
    console.log(`- package root: ${options.packageRoot}`);
    console.log(`- config dir: ${envoqConfigDir() || path.join(os.homedir(), '.envoq')}`);
    console.log(`- hub url: ${hubUrl}`);
    console.log(`- HUB_SECRET: ${hubSecret ? 'set' : 'missing'}`);
    console.log(`- AGENT_ID: ${process.env.AGENT_ID || 'missing'}`);

    try {
        const response = await fetch(healthUrl, { method: 'GET' });
        console.log(`- broker health: HTTP ${response.status}`);
        if (isDebugEnabled()) {
            const body = await responseText(response);
            console.error(`[Envoq debug] broker health url: ${healthUrl}`);
            console.error(`[Envoq debug] broker health status: HTTP ${response.status}`);
            if (body) {
                console.error(`[Envoq debug] broker health body: ${body.slice(0, 4096)}`);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`- broker health: unavailable (${message})`);
        debugLog('broker health request failed', {
            url: healthUrl,
            message,
            stack: error instanceof Error ? error.stack : undefined
        });
    }

    if (!hubSecret) {
        console.log('- plan: unavailable (missing HUB_SECRET)');
        return;
    }

    const billing = await fetchBillingStatus(hubUrl, hubSecret, options.refreshBilling === true);
    printBillingStatus(billing);

    if (options.refreshBilling) {
        const daemonRefresh = await requestDaemonRefresh();
        const label = daemonRefresh === 'refreshed'
            ? 'requested'
            : daemonRefresh === 'not_running'
                ? 'not running'
                : 'failed';
        console.log(`- daemon tunnel refresh: ${label}`);
    }
}
