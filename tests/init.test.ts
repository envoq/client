import { execFile as execFileWithCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFile = promisify(execFileWithCallback);

test('local MCP config uses absolute node and direct MCP runtime paths', async () => {
    const { stdout } = await execFile(
        process.execPath,
        ['--experimental-strip-types', path.join(repoRoot, 'src/cli/init.ts'), '--print-config', 'local'],
        { cwd: repoRoot }
    );
    const parsed = JSON.parse(stdout) as {
        mcpServers?: {
            envoq?: {
                command?: unknown;
                args?: unknown[];
                env?: Record<string, unknown>;
            };
        };
    };
    const config = parsed.mcpServers?.envoq;

    assert.ok(config);
    assert.equal(config.command, process.execPath);
    assert.notEqual(config.command, 'envoq');
    assert.deepEqual(config.args, [path.join(repoRoot, 'dist', 'mcp', 'index.js')]);
    assert.equal(path.isAbsolute(String(config.args?.[0])), true);
    assert.equal(config.env?.ENVOQ_HUB_URL, 'https://api.envoq.tech/api/v1');
});

test('native binary MCP config launches the binary itself with mcp command', async () => {
    const { stdout } = await execFile(
        process.execPath,
        ['--experimental-strip-types', path.join(repoRoot, 'src/cli/init.ts'), '--print-config', 'local'],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                ENVOQ_NATIVE_BINARY: 'true'
            }
        }
    );
    const parsed = JSON.parse(stdout) as {
        mcpServers?: {
            envoq?: {
                command?: unknown;
                args?: unknown[];
                env?: Record<string, unknown>;
            };
        };
    };
    const config = parsed.mcpServers?.envoq;

    assert.ok(config);
    assert.equal(config.command, process.execPath);
    assert.deepEqual(config.args, ['mcp']);
    assert.equal(config.env?.ENVOQ_HUB_URL, 'https://api.envoq.tech/api/v1');
});

test('client package does not install global repair postinstall hook', async () => {
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };

    assert.equal(Object.hasOwn(pkg.scripts ?? {}, 'postinstall'), false);
});

test('init can render PM2 daemon command without running PM2', async () => {
    const { stdout } = await execFile(
        process.execPath,
        ['--experimental-strip-types', path.join(repoRoot, 'src/cli/init.ts'), '--print-pm2-command'],
        { cwd: repoRoot }
    );
    const parsed = JSON.parse(stdout) as { command?: unknown; args?: unknown[] };

    assert.equal(parsed.command, 'pm2');
    assert.ok(Array.isArray(parsed.args));
    assert.deepEqual(parsed.args?.slice(0, 2), ['start', path.join(repoRoot, 'dist', 'daemon', 'index.js')]);
    assert.ok(parsed.args?.includes('envoq-daemon'));
    assert.ok(parsed.args?.includes(process.execPath));
    assert.ok(parsed.args?.includes('--update-env'));
});
