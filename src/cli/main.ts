import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvoqEnv } from '../config/env.ts';
import { printStatus } from './status.ts';
import { ENVOQ_PACKAGE_VERSION } from './build-info.ts';

loadEnvoqEnv();

function packageRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function packageVersion(root: string): string {
    if (ENVOQ_PACKAGE_VERSION) return ENVOQ_PACKAGE_VERSION;

    const packageJsonPath = path.join(root, 'package.json');
    if (!existsSync(packageJsonPath)) {
        return 'unknown';
    }
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return parsed.version || 'unknown';
}

function printHelp(): void {
    console.log(`Envoq CLI

Usage:
  envoq init                      Configure Envoq for AI agents and local projects
  envoq mcp                       Start the Envoq MCP Sidecar over stdio
  envoq sidecar                   Start the Envoq MCP Sidecar over stdio
  envoq daemon                    Start the Envoq Sidecar as a standalone daemon process
  envoq status                    Show local CLI, broker, and billing information
  envoq status --refresh-billing  Refresh billing and ask the daemon to reconnect now
  envoq refresh                   Alias for envoq status --refresh-billing

Flags:
  -h, --help                      Show this help
  -v, --version                   Print the installed Envoq version
  --debug, --verbose              Print detailed diagnostics to stderr

Legacy binaries remain available:
  envoq-mcp-server
`);
}

function enableDebugFromArgs(args: string[]): string[] {
    if (args.includes('--debug') || args.includes('--verbose')) {
        process.env.ENVOQ_DEBUG = '1';
    }
    return args.filter((arg) => arg !== '--debug' && arg !== '--verbose');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const root = packageRoot();
    const filteredArgs = enableDebugFromArgs(argv);
    const refreshBilling = filteredArgs.includes('--refresh-billing');
    const commandArgs = filteredArgs.filter((arg) => arg !== '--refresh-billing');
    const [command, ...args] = commandArgs;

    switch (command) {
        case undefined:
        case '':
        case 'help':
        case '-h':
        case '--help':
            printHelp();
            return;
        case 'version':
        case '-v':
        case '--version':
            console.log(packageVersion(root));
            return;
        case 'init': {
            await runSubcommand(async () => {
                const mod = await import('./init.ts');
                await mod.main(args);
            });
            return;
        }
        case 'mcp':
        case 'sidecar': {
            await runSubcommand(async () => {
                const mod = await import('../mcp/index.ts');
                await mod.main(args);
            });
            return;
        }
        case 'daemon': {
            await runSubcommand(async () => {
                const mod = await import('../daemon/index.ts');
                await mod.main(args);
            });
            return;
        }
        case 'status':
            await printStatus({ packageRoot: root, refreshBilling });
            return;
        case 'refresh':
            await printStatus({ packageRoot: root, refreshBilling: true });
            return;
        default:
            console.error(`Unknown Envoq command: ${command}`);
            console.error('');
            printHelp();
            process.exit(1);
    }
}

async function runSubcommand(fn: () => Promise<void>): Promise<void> {
    const previous = process.env.ENVOQ_CLI_DISPATCH;
    process.env.ENVOQ_CLI_DISPATCH = '1';
    try {
        await fn();
    } finally {
        if (previous === undefined) {
            delete process.env.ENVOQ_CLI_DISPATCH;
        } else {
            process.env.ENVOQ_CLI_DISPATCH = previous;
        }
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`envoq failed: ${message}`);
    process.exit(1);
});
