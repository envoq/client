import { config as loadDotenv } from 'dotenv';
import os from 'node:os';
import path from 'node:path';

export function envoqConfigDir(): string {
    return process.env.ENVOQ_CONFIG_DIR || path.join(os.homedir(), '.envoq');
}

export function envoqEnvPath(): string {
    return path.join(envoqConfigDir(), '.env.local');
}

export function loadEnvoqEnv(): void {
    loadDotenv({ path: envoqEnvPath(), quiet: true, override: false });
    loadDotenv({ quiet: true, override: false });
    loadDotenv({ path: '.env.local', quiet: true, override: false });
}
