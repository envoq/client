import { execFile as execFileWithCallback } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
                ENVOQ_HUB_URL: `http://127.0.0.1:${address.port}/api/v1`
            }
        }
    );

    assert.match(result.stdout, /broker health: HTTP 402/);
    assert.match(result.stderr, /broker health url/);
    assert.match(result.stderr, /payment required for tunnel access/);
});
