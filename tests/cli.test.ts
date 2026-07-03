import { execFile as execFileWithCallback } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFile = promisify(execFileWithCallback);

async function packageVersion(): Promise<string> {
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    return String((JSON.parse(raw) as { version: string }).version);
}

test('native build-info version matches package version', async () => {
    const version = await packageVersion();
    const raw = await readFile(path.join(repoRoot, 'src/cli/build-info.ts'), 'utf8');

    assert.match(raw, new RegExp(`ENVOQ_PACKAGE_VERSION = '${version}'`));
});

test('top-level CLI supports version flags', async () => {
    const expected = `${await packageVersion()}\n`;

    const long = await execFile(process.execPath, [path.join(repoRoot, 'bin/envoq.js'), '--version'], { cwd: repoRoot });
    const short = await execFile(process.execPath, [path.join(repoRoot, 'bin/envoq.js'), '-v'], { cwd: repoRoot });

    assert.equal(long.stdout, expected);
    assert.equal(short.stdout, expected);
});

test('top-level CLI supports help flags', async () => {
    const long = await execFile(process.execPath, [path.join(repoRoot, 'bin/envoq.js'), '--help'], { cwd: repoRoot });
    const short = await execFile(process.execPath, [path.join(repoRoot, 'bin/envoq.js'), '-h'], { cwd: repoRoot });

    for (const output of [long.stdout, short.stdout]) {
        assert.match(output, /envoq init/);
        assert.match(output, /envoq status/);
        assert.match(output, /envoq daemon/);
        assert.match(output, /--version/);
        assert.match(output, /--debug/);
    }
});

test('status --debug prints broker response details to stderr', async (t) => {
    const server = http.createServer((req, res) => {
        assert.equal(req.url, '/api/v1/health');
        res.writeHead(402, { 'content-type': 'text/plain' });
        res.end('payment required for tunnel access');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Missing test server address');
    }

    const result = await execFile(
        process.execPath,
        [path.join(repoRoot, 'bin/envoq.js'), 'status', '--debug'],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                ENVOQ_HUB_URL: `http://127.0.0.1:${address.port}/api/v1`,
                HUB_SECRET: '',
                ENVOQ_API_KEY: '',
                AGENT_ID: 'cli-test'
            }
        }
    );

    assert.match(result.stdout, /broker health: HTTP 402/);
    assert.match(result.stderr, /broker health url/);
    assert.match(result.stderr, /payment required for tunnel access/);
});

test('status prints billing plan when credentials are configured', async (t) => {
    const server = http.createServer((req, res) => {
        if (req.url === '/api/v1/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.url === '/api/v1/billing/status') {
            assert.equal(req.headers.authorization, 'Bearer evq_live_test');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                tenant_id: 'tenant_test',
                plan: 'free',
                plan_label: 'Free',
                billing_status: 'active',
                status: 'active',
                tunnel_allowed: true,
                remaining_balance: 25,
                alert_message: 'You have used at least 80% of your monthly Envoq usage limit.'
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Missing test server address');
    }
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'envoq-cli-status-'));

    const result = await execFile(
        process.execPath,
        [path.join(repoRoot, 'bin/envoq.js'), 'status'],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                ENVOQ_CONFIG_DIR: configDir,
                ENVOQ_HUB_URL: `http://127.0.0.1:${address.port}/api/v1`,
                HUB_SECRET: 'evq_live_test',
                ENVOQ_API_KEY: '',
                AGENT_ID: 'cli-test'
            }
        }
    );

    assert.match(result.stdout, /broker health: HTTP 200/);
    assert.match(result.stdout, /plan: Free/);
    assert.match(result.stdout, /billing status: active/);
    assert.match(result.stdout, /tunnel allowed: yes/);
    assert.match(result.stdout, /alert: You have used at least 80%/);
});

test('status --refresh-billing posts refresh and reports missing local daemon', async (t) => {
    let refreshes = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/api/v1/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.method === 'POST' && req.url === '/api/v1/billing/refresh') {
            refreshes += 1;
            assert.equal(req.headers.authorization, 'Bearer evq_live_test');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                tenant_id: 'tenant_test',
                plan: 'team',
                plan_label: 'Team',
                billing_status: 'active',
                status: 'active',
                tunnel_allowed: true
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Missing test server address');
    }
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'envoq-cli-refresh-'));

    const result = await execFile(
        process.execPath,
        [path.join(repoRoot, 'bin/envoq.js'), 'status', '--refresh-billing'],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                ENVOQ_CONFIG_DIR: configDir,
                ENVOQ_HUB_URL: `http://127.0.0.1:${address.port}/api/v1`,
                HUB_SECRET: 'evq_live_test',
                ENVOQ_API_KEY: '',
                AGENT_ID: 'cli-test'
            }
        }
    );

    assert.equal(refreshes, 1);
    assert.match(result.stdout, /plan: Team/);
    assert.match(result.stdout, /daemon tunnel refresh: not running/);
});

test('native build script exposes expected release asset names', async () => {
    const { stdout } = await execFile(process.execPath, [path.join(repoRoot, 'scripts/build-native.mjs'), '--dry-run'], {
        cwd: repoRoot
    });
    const parsed = JSON.parse(stdout) as { targets?: Array<{ asset?: string; bun?: string }> };
    const assets = parsed.targets?.map((target) => target.asset) ?? [];

    assert.deepEqual(assets, [
        'envoq-linux-x64',
        'envoq-linux-x64-baseline',
        'envoq-linux-arm64',
        'envoq-macos-x64',
        'envoq-macos-arm64',
        'envoq-windows-x64.exe'
    ]);
});

test('install.sh is valid bash syntax', async () => {
    await execFile('bash', ['-n', path.join(repoRoot, 'install.sh')], { cwd: repoRoot });
});
