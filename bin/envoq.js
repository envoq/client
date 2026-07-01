#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = process.env.ENVOQ_CONFIG_DIR || join(os.homedir(), '.envoq');

loadDotenv({ path: join(configDir, '.env.local'), quiet: true, override: false });
loadDotenv({ quiet: true, override: false });
loadDotenv({ path: '.env.local', quiet: true, override: false });

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

function isDebugEnabled() {
    const value = process.env.ENVOQ_DEBUG || process.env.DEBUG;
    return value === '1' || value === 'true' || value === 'envoq' || value === 'envoq:*';
}

function debugLog(message, details) {
    if (!isDebugEnabled()) return;
    if (details === undefined) {
        console.error(`[Envoq debug] ${message}`);
        return;
    }
    console.error(`[Envoq debug] ${message}: ${JSON.stringify(details, null, 2)}`);
}

function printHelp() {
    console.log(`Envoq CLI

Usage:
  envoq init              Configure Envoq for AI agents and local projects
  envoq mcp               Start the Envoq MCP Sidecar over stdio
  envoq sidecar           Start the Envoq MCP Sidecar over stdio
  envoq daemon            Start the Envoq Sidecar as a standalone daemon process
  envoq status            Show local CLI and broker health information

Flags:
  -h, --help              Show this help
  -v, --version           Print the installed Envoq version
  --debug, --verbose      Print detailed diagnostics to stderr

Legacy binaries remain available:
  envoq-mcp-server
`);
}

function spawnNode(entrypoint, args) {
    debugLog('Spawning Envoq runtime', {
        node: process.execPath,
        entrypoint: resolve(root, entrypoint),
        args
    });
    const child = spawn(process.execPath, [resolve(root, entrypoint), ...args], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: process.env
    });

    child.on('error', (error) => {
        console.error(error.message);
        process.exit(1);
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 1);
    });
}

function joinUrl(base, path) {
    const cleanBase = base.replace(/\/+$/, '');
    const cleanPath = path.replace(/^\/+/, '');
    return `${cleanBase}/${cleanPath}`;
}

async function printStatus() {
    const hubUrl = process.env.ENVOQ_HUB_URL || 'https://api.envoq.tech/api/v1';
    const healthUrl = joinUrl(hubUrl, 'health');

    console.log('Envoq CLI status');
    console.log(`- package root: ${root}`);
    console.log(`- hub url: ${hubUrl}`);
    console.log(`- HUB_SECRET: ${process.env.HUB_SECRET ? 'set' : 'missing'}`);
    console.log(`- AGENT_ID: ${process.env.AGENT_ID || 'missing'}`);

    try {
        const response = await fetch(healthUrl, { method: 'GET' });
        console.log(`- broker health: HTTP ${response.status}`);
        if (isDebugEnabled()) {
            const body = await response.text().catch((error) => `Unable to read response body: ${error.message}`);
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
}

const rawArgs = process.argv.slice(2);
const debugEnabled = rawArgs.includes('--debug') || rawArgs.includes('--verbose');
if (debugEnabled) {
    process.env.ENVOQ_DEBUG = '1';
}
const filteredArgs = rawArgs.filter((arg) => arg !== '--debug' && arg !== '--verbose');
const [command, ...args] = filteredArgs;

switch (command) {
    case undefined:
    case '':
    case 'help':
    case '-h':
    case '--help':
        printHelp();
        break;
    case 'version':
    case '-v':
    case '--version':
        console.log(packageJson.version);
        break;
    case 'init':
        spawnNode('dist/cli/init.js', args);
        break;
    case 'mcp':
    case 'sidecar':
        spawnNode('bin/envoq-sidecar.js', args);
        break;
    case 'daemon':
        spawnNode('dist/daemon/index.js', args);
        break;
    case 'status':
        await printStatus();
        break;
    default:
        console.error(`Unknown Envoq command: ${command}`);
        console.error('');
        printHelp();
        process.exit(1);
}
