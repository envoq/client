#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotenv({ quiet: true, override: false });
loadDotenv({ path: '.env.local', quiet: true, override: false });

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function printHelp() {
    console.log(`Envoq CLI

Usage:
  envoq init              Configure Envoq for AI agents and local projects
  envoq mcp               Start the Envoq MCP Sidecar over stdio
  envoq sidecar           Start the Envoq MCP Sidecar over stdio
  envoq status            Show local CLI and broker health information

Legacy binaries remain available:
  envoq-mcp-server
`);
}

function spawnNode(entrypoint, args) {
    const child = spawn(process.execPath, [resolve(root, entrypoint), ...args], {
        cwd: root,
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
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`- broker health: unavailable (${message})`);
    }
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
    case undefined:
    case '':
    case 'help':
    case '-h':
    case '--help':
        printHelp();
        break;
    case 'init':
        spawnNode('dist/cli/init.js', args);
        break;
    case 'mcp':
    case 'sidecar':
        spawnNode('bin/envoq-sidecar.js', args);
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
