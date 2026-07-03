#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');
const outDir = resolve(root, 'dist-native');
const entrypoint = resolve(root, 'src/cli/main.ts');
const dryRun = process.argv.includes('--dry-run');

const targets = [
    { bun: 'bun-linux-x64', asset: 'envoq-linux-x64' },
    { bun: 'bun-linux-x64-baseline', asset: 'envoq-linux-x64-baseline' },
    { bun: 'bun-linux-arm64', asset: 'envoq-linux-arm64' },
    { bun: 'bun-darwin-x64', asset: 'envoq-macos-x64' },
    { bun: 'bun-darwin-arm64', asset: 'envoq-macos-arm64' },
    { bun: 'bun-windows-x64', asset: 'envoq-windows-x64.exe' }
];

function sha256(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function run(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: dryRun ? 'pipe' : 'inherit',
        env
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
    }
}

if (dryRun) {
    console.log(JSON.stringify({ version, outDir, entrypoint, targets }, null, 2));
    process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const target of targets) {
    const outfile = resolve(outDir, target.asset);
    run('bun', [
        'build',
        entrypoint,
        '--compile',
        `--target=${target.bun}`,
        `--outfile=${outfile}`,
        '--no-compile-autoload-package-json',
        '--no-compile-autoload-tsconfig'
    ]);
}

const checksums = targets
    .map((target) => `${sha256(resolve(outDir, target.asset))}  ${basename(target.asset)}`)
    .join('\n');
writeFileSync(resolve(outDir, 'checksums.txt'), `${checksums}\n`, 'utf8');
console.log(`Built ${targets.length} native Envoq binaries in ${outDir}`);
