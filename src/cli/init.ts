import { config as loadDotenv } from 'dotenv';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';

loadDotenv({ quiet: true, override: false });
loadDotenv({ path: '.env.local', quiet: true, override: false });

type InitMode = 'local' | 'cloud' | 'rest';
type McpConfigFormat = 'json' | 'codex-toml';

interface McpClientCandidate {
    name: string;
    path: string;
    format: McpConfigFormat;
}

interface JsonObject {
    [key: string]: unknown;
}

const CLOUD_MCP_URL = 'https://api.envoq.tech/api/v1/mcp/stateless';
const REST_BASE_URL = 'https://api.envoq.tech/api/v1';
const SIDECAR_HUB_URL = 'https://api.envoq.tech/api/v1';

function printHelp() {
    console.log(`Envoq init

Usage:
  envoq init
  envoq init --print-config local
  envoq init --print-config cloud

The wizard configures one of three modes:
  Local Sidecar   MCP stdio sidecar with outbound broker connectivity
  Cloud MCP       Hosted stateless MCP endpoint at https://api.envoq.tech/api/v1/mcp/stateless
  REST API        Project .env.local for direct REST calls
`);
}

function homePath(...segments: string[]) {
    return path.join(os.homedir(), ...segments);
}

function workspacePath(...segments: string[]) {
    return path.join(process.cwd(), ...segments);
}

function candidate(name: string, filePath: string, format: McpConfigFormat = 'json'): McpClientCandidate {
    return { name, path: filePath, format };
}

function dotConfig(appName: string, fileName = 'mcp.json') {
    return homePath('.config', appName, fileName);
}

function dotHome(dirName: string, fileName = 'mcp.json') {
    return homePath(dirName, fileName);
}

function codeUserPath(...segments: string[]) {
    const appData = process.env.APPDATA;

    if (process.platform === 'win32' && appData) {
        return path.join(appData, 'Code', 'User', ...segments);
    }
    if (process.platform === 'darwin') {
        return homePath('Library', 'Application Support', 'Code', 'User', ...segments);
    }
    return homePath('.config', 'Code', 'User', ...segments);
}

function uniqueCandidates(candidates: McpClientCandidate[]): McpClientCandidate[] {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = `${candidate.format}:${candidate.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function candidateConfigs(): McpClientCandidate[] {
    const appData = process.env.APPDATA;
    const userProfile = process.env.USERPROFILE;
    const windowsHome = userProfile || os.homedir();

    return uniqueCandidates([
        candidate(
            'Claude Desktop',
            process.platform === 'darwin'
                ? homePath('Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
                : process.platform === 'win32' && appData
                    ? path.join(appData, 'Claude', 'claude_desktop_config.json')
                    : homePath('.config', 'Claude', 'claude_desktop_config.json')
        ),
        candidate('Claude Desktop', homePath('.config', 'claude', 'claude_desktop_config.json')),
        candidate('Claude Code CLI', workspacePath('.mcp.json')),
        candidate('Claude Code CLI', homePath('.claude', 'mcp.json')),
        candidate('Claude Code CLI', dotConfig('claude-code')),
        candidate(
            'Cursor',
            process.platform === 'win32'
                ? path.join(windowsHome, '.cursor', 'mcp.json')
                : homePath('.cursor', 'mcp.json')
        ),
        candidate('Codex CLI', homePath('.codex', 'config.toml'), 'codex-toml'),
        candidate('Google Antigravity CLI', homePath('.gemini', 'config', 'mcp_config.json')),
        candidate('Google Antigravity workspace', workspacePath('.agents', 'mcp_config.json')),
        candidate('Aider CLI', dotHome('.aider')),
        candidate('Aider CLI', dotConfig('aider')),
        candidate('GitHub Copilot CLI', dotHome('.github-copilot')),
        candidate('GitHub Copilot CLI', dotConfig('github-copilot')),
        candidate('Amazon Q Developer', dotHome('.amazonq')),
        candidate('Amazon Q Developer', dotConfig('amazonq')),
        candidate('Amazon Q Developer', homePath('.aws', 'amazonq', 'mcp.json')),
        candidate('Cline', dotHome('.cline')),
        candidate('Cline', dotConfig('cline')),
        candidate('Cline VS Code extension', codeUserPath('globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')),
        candidate('Kiro', dotHome('.kiro')),
        candidate('Kiro workspace', workspacePath('.kiro', 'settings', 'mcp.json')),
        candidate('Kilo Code CLI', dotHome('.kilo-code')),
        candidate('Kilo Code CLI', dotConfig('kilo-code')),
        candidate('Kilo Code VS Code extension', codeUserPath('globalStorage', 'kilocode.kilo-code', 'settings', 'mcp_settings.json')),
        candidate('Replit', dotHome('.replit')),
        candidate('Replit workspace', workspacePath('.replit', 'mcp.json')),
        candidate('Lovable', dotHome('.lovable')),
        candidate('Lovable', dotConfig('lovable')),
        candidate('OpenCode CLI', dotHome('.opencode')),
        candidate('OpenCode CLI', dotConfig('opencode')),
        candidate('Kimi Code CLI', dotHome('.kimi-code')),
        candidate('Kimi Code CLI', dotConfig('kimi-code')),
        candidate('Kimi Code CLI', homePath('.kimi', 'mcp.json')),
        candidate('Hermes CLI', dotHome('.hermes')),
        candidate('Hermes CLI', dotConfig('hermes')),
        candidate('Mistral Vibe', dotHome('.mistral-vibe')),
        candidate('Mistral Vibe', dotConfig('mistral-vibe')),
        candidate('Qwen Code', dotHome('.qwen-code')),
        candidate('Qwen Code', dotConfig('qwen-code')),
        candidate('Qwen Code', homePath('.qwen', 'mcp.json')),
        candidate('Xiaomi MiMo Code', dotHome('.mimo-code')),
        candidate('Xiaomi MiMo Code', dotConfig('mimo-code')),
        candidate('Roo Code', dotHome('.roo-code')),
        candidate('Roo Code', dotConfig('roo-code')),
        candidate('Roo Code VS Code extension', codeUserPath('globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')),
        candidate('OpenHands CLI', dotHome('.openhands')),
        candidate('OpenHands CLI', dotConfig('openhands')),
        candidate('Augment Code CLI', dotHome('.augment')),
        candidate('Augment Code CLI', dotConfig('augment-code')),
        candidate('Tabnine', dotHome('.tabnine')),
        candidate('Tabnine', dotConfig('tabnine')),
        candidate('Sourcegraph Cody', dotHome('.sourcegraph-cody')),
        candidate('Sourcegraph Cody', dotConfig('sourcegraph-cody')),
        candidate('Sourcegraph Cody VS Code extension', codeUserPath('globalStorage', 'sourcegraph.cody-ai', 'settings', 'mcp.json')),
        candidate(
            'Windsurf',
            process.platform === 'win32'
                ? path.join(windowsHome, '.windsurf', 'mcp.json')
                : homePath('.windsurf', 'mcp.json')
        ),
        candidate(
            'Windsurf',
            process.platform === 'win32' && appData
                ? path.join(appData, 'Codeium', 'Windsurf', 'mcp_config.json')
                : homePath('.codeium', 'windsurf', 'mcp_config.json')
        ),
        candidate('JetBrains AI', dotHome('.jetbrains-ai')),
        candidate('JetBrains AI', homePath('.config', 'JetBrains', 'AI', 'mcp.json'))
    ]);
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function defaultAgentId() {
    const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'local-agent';
    return `a2a:agent:default:${host}`.slice(0, 64);
}

function localMcpConfig(hubSecret: string, agentId: string): JsonObject {
    return {
        command: 'envoq',
        args: ['mcp'],
        env: {
            HUB_SECRET: hubSecret,
            AGENT_ID: agentId,
            ENVOQ_HUB_URL: SIDECAR_HUB_URL
        }
    };
}

function cloudMcpConfig(apiKey: string): JsonObject {
    return {
        url: CLOUD_MCP_URL,
        headers: {
            Authorization: `Bearer ${apiKey}`
        }
    };
}

function mcpConfigEnvelope(config: JsonObject): JsonObject {
    return {
        mcpServers: {
            envoq: config
        }
    };
}

function parseJsonObject(raw: string, filePath: string): JsonObject {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${filePath} must contain a JSON object`);
    }
    return parsed as JsonObject;
}

async function readJsonConfig(filePath: string): Promise<JsonObject> {
    if (!(await pathExists(filePath))) {
        return {};
    }
    const raw = await readFile(filePath, 'utf8');
    if (!raw.trim()) {
        return {};
    }
    return parseJsonObject(raw, filePath);
}

async function mergeJsonMcpConfig(filePath: string, config: JsonObject): Promise<void> {
    const existing = await readJsonConfig(filePath);
    const servers = existing.mcpServers;
    const nextServers: JsonObject = servers && typeof servers === 'object' && !Array.isArray(servers)
        ? { ...(servers as JsonObject) }
        : {};

    nextServers.envoq = config;
    const nextConfig = {
        ...existing,
        mcpServers: nextServers
    };

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
}

function tomlString(value: string) {
    return JSON.stringify(value);
}

function tomlArray(values: string[]) {
    return `[${values.map(tomlString).join(', ')}]`;
}

function recordFromUnknown(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
}

function removeTomlSections(raw: string, sectionNames: Set<string>) {
    const lines = raw.split(/\r?\n/);
    const nextLines: string[] = [];
    let skipping = false;

    for (const line of lines) {
        const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (match?.[1]) {
            skipping = sectionNames.has(match[1]);
        }
        if (!skipping) {
            nextLines.push(line);
        }
    }

    return nextLines.join('\n').replace(/\s+$/, '');
}

function renderCodexMcpConfig(config: JsonObject) {
    const lines: string[] = ['[mcp_servers.envoq]'];
    const command = typeof config.command === 'string' ? config.command : undefined;
    const args = Array.isArray(config.args) && config.args.every((arg) => typeof arg === 'string')
        ? config.args
        : undefined;
    const url = typeof config.url === 'string' ? config.url : undefined;
    const env = recordFromUnknown(config.env);
    const headers = recordFromUnknown(config.headers);

    if (command) {
        lines.push(`command = ${tomlString(command)}`);
    }
    if (args) {
        lines.push(`args = ${tomlArray(args)}`);
    }
    if (url) {
        lines.push(`url = ${tomlString(url)}`);
    }
    lines.push('startup_timeout_sec = 20');
    lines.push('tool_timeout_sec = 20');
    lines.push('default_tools_approval_mode = "approve"');

    if (Object.keys(headers).length > 0) {
        lines.push('');
        lines.push('[mcp_servers.envoq.headers]');
        for (const [key, value] of Object.entries(headers)) {
            lines.push(`${key} = ${tomlString(value)}`);
        }
    }

    if (Object.keys(env).length > 0) {
        lines.push('');
        lines.push('[mcp_servers.envoq.env]');
        for (const [key, value] of Object.entries(env)) {
            lines.push(`${key} = ${tomlString(value)}`);
        }
    }

    return `${lines.join('\n')}\n`;
}

async function mergeCodexTomlConfig(filePath: string, config: JsonObject): Promise<void> {
    const existing = await readFile(filePath, 'utf8').catch(() => '');
    const preserved = removeTomlSections(existing, new Set([
        'mcp_servers.envoq',
        'mcp_servers.envoq.env',
        'mcp_servers.envoq.headers'
    ]));
    const nextConfig = preserved
        ? `${preserved}\n\n${renderCodexMcpConfig(config)}`
        : renderCodexMcpConfig(config);

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, nextConfig, 'utf8');
}

async function mergeMcpConfig(candidate: McpClientCandidate, config: JsonObject): Promise<void> {
    if (candidate.format === 'codex-toml') {
        await mergeCodexTomlConfig(candidate.path, config);
        return;
    }
    await mergeJsonMcpConfig(candidate.path, config);
}

function envValue(value: string) {
    return /^[A-Za-z0-9_:/@.+-]+$/.test(value) ? value : JSON.stringify(value);
}

function mergeEnvContent(existing: string, values: Record<string, string>) {
    const remaining = new Map(Object.entries(values));
    const lines = existing.length ? existing.split(/\r?\n/) : [];
    const nextLines = lines.map((line) => {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!match) return line;
        const key = match[1];
        if (!key) return line;
        const value = remaining.get(key);
        if (value === undefined) return line;
        remaining.delete(key);
        return `${key}=${envValue(value)}`;
    });

    if (remaining.size > 0 && nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
        nextLines.push('');
    }
    for (const [key, value] of remaining) {
        nextLines.push(`${key}=${envValue(value)}`);
    }

    return `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
}

async function writeProjectEnv(values: Record<string, string>): Promise<void> {
    const envPath = path.join(process.cwd(), '.env.local');
    const existing = await readFile(envPath, 'utf8').catch(() => '');
    await writeFile(envPath, mergeEnvContent(existing, values), 'utf8');
}

async function askRequired(rl: Interface, question: string): Promise<string> {
    while (true) {
        const answer = (await rl.question(question)).trim();
        if (answer) return answer;
        console.log('This value is required.');
    }
}

async function askApiKey(rl: Interface, mode: InitMode): Promise<string> {
    while (true) {
        const label = mode === 'local'
            ? 'Envoq API key or sidecar HUB_SECRET'
            : 'Envoq API key';
        const value = await askRequired(rl, `${label}: `);
        if (value.startsWith('evq_live_')) {
            return value;
        }
        if (mode === 'local') {
            const confirm = (await rl.question('That does not look like an evq_live_ key. Use it as HUB_SECRET anyway? [y/N] ')).trim().toLowerCase();
            if (confirm === 'y' || confirm === 'yes') {
                return value;
            }
        } else {
            console.log('Cloud MCP and REST API mode require a live Envoq API key beginning with evq_live_.');
        }
    }
}

async function askMode(rl: Interface): Promise<InitMode> {
    console.log('Choose an Envoq integration mode:');
    console.log('  1. Local Sidecar - MCP stdio process with outbound broker connectivity');
    console.log('  2. Cloud MCP - hosted stateless MCP endpoint');
    console.log('  3. REST API - write project environment variables only');

    while (true) {
        const answer = (await rl.question('Mode [1]: ')).trim().toLowerCase();
        if (!answer || answer === '1' || answer === 'local' || answer === 'sidecar') return 'local';
        if (answer === '2' || answer === 'cloud' || answer === 'serverless') return 'cloud';
        if (answer === '3' || answer === 'rest' || answer === 'api') return 'rest';
        console.log('Enter 1, 2, or 3.');
    }
}

async function configureMcpClients(config: JsonObject): Promise<void> {
    const candidates = candidateConfigs();

    console.log('\nWriting Envoq MCP config to supported client paths:');
    candidates.forEach((candidate, index) => {
        console.log(`  ${index + 1}. ${candidate.name}: ${candidate.path}`);
    });

    for (const candidate of candidates) {
        await mergeMcpConfig(candidate, config);
        console.log(`Updated ${candidate.name}: ${candidate.path}`);
    }
}

async function runWizard(): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const mode = await askMode(rl);
        const apiKey = await askApiKey(rl, mode);
        const defaultId = defaultAgentId();
        const agentIdAnswer = (await rl.question(`Agent ID [${defaultId}]: `)).trim();
        const agentId = agentIdAnswer || defaultId;

        const envValues = {
            ENVOQ_API_KEY: apiKey,
            HUB_SECRET: apiKey,
            AGENT_ID: agentId,
            ENVOQ_BASE_URL: REST_BASE_URL,
            ENVOQ_HUB_URL: mode === 'local' ? SIDECAR_HUB_URL : REST_BASE_URL
        };

        await writeProjectEnv(envValues);
        console.log(`Wrote ${path.join(process.cwd(), '.env.local')}`);

        if (mode === 'local') {
            await configureMcpClients(localMcpConfig(apiKey, agentId));
        } else if (mode === 'cloud') {
            await configureMcpClients(cloudMcpConfig(apiKey));
        } else {
            console.log('\nREST API mode is ready. Use ENVOQ_API_KEY and ENVOQ_BASE_URL from .env.local.');
        }

        console.log('\nNext steps:');
        if (mode === 'local') {
            console.log('  envoq mcp');
            console.log('  Ask your MCP client to call envoq_status.');
        } else if (mode === 'cloud') {
            console.log('  Restart your MCP client and call list_envoq_agents.');
        } else {
            console.log('  curl "$ENVOQ_BASE_URL/health" -H "Authorization: Bearer $ENVOQ_API_KEY"');
        }
    } finally {
        rl.close();
    }
}

function printConfig(kind: string | undefined) {
    if (kind === 'local') {
        console.log(JSON.stringify(mcpConfigEnvelope(localMcpConfig('evq_live_USER_KEY_HERE', 'a2a:agent:default:local-agent')), null, 2));
        return;
    }
    if (kind === 'cloud') {
        console.log(JSON.stringify(mcpConfigEnvelope(cloudMcpConfig('evq_live_USER_KEY_HERE')), null, 2));
        return;
    }
    throw new Error('Use --print-config local or --print-config cloud');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    if (argv.includes('-h') || argv.includes('--help')) {
        printHelp();
        return;
    }

    const printConfigIndex = argv.indexOf('--print-config');
    if (printConfigIndex !== -1) {
        printConfig(argv[printConfigIndex + 1]);
        return;
    }

    await runWizard();
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`envoq init failed: ${message}`);
    process.exit(1);
});
