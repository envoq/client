#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntrypoint = resolve(root, 'dist/cli/main.js');
const sourceEntrypoint = resolve(root, 'src/cli/main.ts');

if (existsSync(distEntrypoint)) {
    await import(distEntrypoint);
} else {
    const child = spawn(process.execPath, ['--experimental-strip-types', sourceEntrypoint, ...process.argv.slice(2)], {
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
