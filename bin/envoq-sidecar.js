#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotenv({ quiet: true, override: false });
loadDotenv({ path: '.env.local', quiet: true, override: false });

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = resolve(root, 'dist/mcp/index.js');

if (!process.env.HUB_SECRET || !process.env.AGENT_ID) {
    console.error('FATAL: HUB_SECRET and AGENT_ID environment variables are required to start the Envoq MCP server.');
    console.error('Example: ENVOQ_HUB_URL=https://api.envoq.tech/api/v1 HUB_SECRET=... AGENT_ID=... envoq-sidecar');
    process.exit(1);
}

const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
