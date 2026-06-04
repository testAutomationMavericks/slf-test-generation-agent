/**
 * ui/server.ts
 *
 * Local Express server — serves the UI and bridges Claude Code or
 * the Anthropic API for test generation.
 *
 * Generation modes:
 *   claudecode  — spawns `claude --print "<prompt>"` in the project root
 *                 Uses your Claude Code subscription, no API key needed.
 *   api         — calls the Anthropic Messages API directly.
 *                 Requires ANTHROPIC_API_KEY.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getAllMCPTools } from '../src/mcp-utils.js';
import { LocalKnowledgeBase, retrieveLocalContextForIssue } from '../src/local-kb/local-vector-db.js';
import { formatTestCaseDocument } from '../src/knowledge-base/formatters.js';
import { createApprovalStore } from '../src/approvals/approval-store.js';
import type { JiraIssue, ZephyrTestCase } from './client/src/types/api.js';

// ─── Voyage-3 Embeddings (Phase 1 scaling) ────────────────────────────────────
// Falls back to deterministic embeddings if no API key configured
async function getEmbedding(text: string): Promise<number[]> {
  const key = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return []; // local-vector-db will use its own deterministic embed

  try {
    const res = await fetch('https://api.anthropic.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'voyage-3',
        input: text.slice(0, 8000),
        input_type: 'document',
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data?.[0]?.embedding ?? [];
  } catch {
    return []; // fallback to deterministic
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Express + WS ─────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── KB Backend (Phase 1 = local JSON, Phase 2 = pgvector) ──────────────────
function createKB(): IKnowledgeBase {
  if (config.kbBackend === 'pgvector') {
    const dbUrl = config.databaseUrl || process.env.DATABASE_URL;
    const apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!dbUrl) {
      console.warn('  ⚠ KB_BACKEND=pgvector but DATABASE_URL not set — falling back to local');
      return new LocalKnowledgeBase(path.join(ROOT, 'local-kb-data'));
    }
    if (!apiKey) {
      console.warn('  ⚠ KB_BACKEND=pgvector but ANTHROPIC_API_KEY not set — falling back to local');
      return new LocalKnowledgeBase(path.join(ROOT, 'local-kb-data'));
    }
    console.log('  KB backend: pgvector (Phase 2)');
    return new PgKnowledgeBase(dbUrl, apiKey);
  }
  console.log('  KB backend: local JSON (Phase 1)');
  return new LocalKnowledgeBase(path.join(ROOT, 'local-kb-data'));
}

// db and approvalStore are initialised after config is loaded below
let db: IKnowledgeBase;
let approvalStore: any;

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(ROOT, 'ui-config.json');

export interface UIConfig {
  mode: 'mock' | 'live';
  /** Which AI engine to use for generation */
  aiProvider: 'claudecode' | 'anthropic' | 'openai' | 'local';
  /** @deprecated use aiProvider */
  claudeMode?: string;
  // ── Atlassian ──────────────────────────────────────────────────────────────
  jiraUrl: string;
  jiraBearerToken: string;   // OAuth/PAT — when set, username not required
  jiraUsername: string;      // Basic Auth only — leave blank when using bearerToken
  jiraApiToken: string;      // Basic Auth only — leave blank when using bearerToken
  confluenceUrl: string;
  confluenceSpaceKey: string;
  confluenceUsername: string;
  confluenceApiToken: string;
  jiraProjectKey: string;
  zephyrApiToken: string;
  zephyrBaseUrl: string;
  // ── Anthropic ──────────────────────────────────────────────────────────────
  anthropicApiKey: string;
  claudeModel: string;
  // ── OpenAI ────────────────────────────────────────────────────────────────
  openaiApiKey: string;
  openaiModel: string;       // e.g. gpt-4o, gpt-4o-mini, o3
  // ── Local / Ollama ────────────────────────────────────────────────────────
  localBaseUrl: string;      // e.g. http://localhost:11434/v1
  localModel: string;        // e.g. llama3.2, mistral, codestral
  localApiKey: string;       // optional — some local servers need one
  // ── General ───────────────────────────────────────────────────────────────
  autoSaveToKB: boolean;
  kbBackend: 'local' | 'pgvector';
  databaseUrl: string;
}

function loadConfig(): UIConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // Migrate legacy claudeMode field
    if (saved.claudeMode && !saved.aiProvider) {
      saved.aiProvider = saved.claudeMode === 'api' ? 'anthropic' : saved.claudeMode;
    }
    return { aiProvider: 'claudecode', ...saved };
  }
  return {
    mode: 'mock',
    aiProvider: 'claudecode',
    jiraUrl: process.env.JIRA_URL ?? '',
    jiraBearerToken: process.env.JIRA_BEARER_TOKEN ?? '',
    jiraUsername: process.env.JIRA_USERNAME ?? '',
    jiraApiToken: process.env.JIRA_API_TOKEN ?? '',
    confluenceUrl: process.env.CONFLUENCE_URL ?? '',
    confluenceSpaceKey: process.env.CONFLUENCE_SPACE_KEY ?? '',
    confluenceUsername: process.env.CONFLUENCE_USERNAME ?? '',
    confluenceApiToken: process.env.CONFLUENCE_API_TOKEN ?? '',
    jiraProjectKey: process.env.JIRA_PROJECT_KEY ?? '',
    zephyrApiToken: process.env.ZEPHYR_API_TOKEN ?? '',
    zephyrBaseUrl: process.env.ZEPHYR_BASE_URL ?? 'https://api.zephyrscale.smartbear.com/v2',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-20250514',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o',
    localBaseUrl: process.env.LOCAL_MODEL_URL ?? 'http://localhost:11434/v1',
    localModel: process.env.LOCAL_MODEL ?? 'llama3.2',
    localApiKey: process.env.LOCAL_MODEL_API_KEY ?? '',
    autoSaveToKB: false,
  };
}

function saveConfig(c: UIConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

let config = loadConfig();

// Now config is loaded — safe to create KB and approval store
db = createKB();
approvalStore = createApprovalStore({
  filePath: path.join(ROOT, 'approvals.json'),
  databaseUrl: config.databaseUrl || process.env.DATABASE_URL,
  kbBackend: config.kbBackend,
});

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

function broadcast(event: string, data: unknown) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ─── MCP clients (used by API mode only) ─────────────────────────────────────

let mcpClients: { jira?: Client; confluence?: Client; zephyr?: Client } = {};
let mcpConnected = false;

async function startMockClient(name: string, file: string): Promise<Client> {
  // Use the local tsx binary from node_modules to avoid PATH issues
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const tsxCmd = fs.existsSync(tsxBin) ? tsxBin : 'npx';
  const tsxArgs = fs.existsSync(tsxBin)
    ? [path.join(ROOT, file)]
    : ['tsx', path.join(ROOT, file)];

  const transport = new StdioClientTransport({
    command: tsxCmd,
    args: tsxArgs,
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development' },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function startLiveAtlassian(): Promise<Client> {
  const usingBearer = !!config.jiraBearerToken;
  const atlassianEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    JIRA_URL: config.jiraUrl,
    CONFLUENCE_URL: config.confluenceUrl,
  };
  if (usingBearer) {
    atlassianEnv.JIRA_PERSONAL_TOKEN = config.jiraBearerToken;
    atlassianEnv.CONFLUENCE_PERSONAL_TOKEN = config.jiraBearerToken;
  } else {
    atlassianEnv.JIRA_USERNAME = config.jiraUsername;
    atlassianEnv.JIRA_API_TOKEN = config.jiraApiToken;
    atlassianEnv.CONFLUENCE_USERNAME = config.confluenceUsername;
    atlassianEnv.CONFLUENCE_API_TOKEN = config.confluenceApiToken;
  }
  // Extend PATH to find uvx regardless of how/where uv was installed
  const extraPaths = [
    `${process.env.HOME}/Library/Python/3.9/bin`,
    `${process.env.HOME}/Library/Python/3.10/bin`,
    `${process.env.HOME}/Library/Python/3.11/bin`,
    `${process.env.HOME}/Library/Python/3.12/bin`,
    `${process.env.HOME}/.local/bin`,
    '/usr/local/bin',
  ].join(':');
  atlassianEnv.PATH = `${extraPaths}:${process.env.PATH ?? ''}`;
  const transport = new StdioClientTransport({ command: 'uvx', args: ['--system-certs', 'mcp-atlassian'], env: atlassianEnv });
  const client = new Client({ name: 'atlassian-live', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function startLiveZephyr(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx', args: ['-y', '@smartbear/mcp@latest'],
    env: { ...process.env, ZEPHYR_API_TOKEN: config.zephyrApiToken, ZEPHYR_BASE_URL: config.zephyrBaseUrl },
  });
  const client = new Client({ name: 'zephyr-live', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

// ─── Sync .mcp.json with current mode ────────────────────────────────────────

/**
 * When Claude Code runs `--print`, it reads .mcp.json in the project root
 * to start its own MCP servers. We rewrite .mcp.json to match the UI's
 * current mode (mock or live) so Claude Code uses the same servers.
 */
function syncMCPJson() {
  const mockConfig = {
    mcpServers: {
      jira:       { command: 'npx', args: ['tsx', 'src/mocks/jira-server.ts'] },
      confluence: { command: 'npx', args: ['tsx', 'src/mocks/confluence-server.ts'] },
      zephyr:     { command: 'npx', args: ['tsx', 'src/mocks/zephyr-server.ts'] },
    },
  };

  const liveConfig = {
    mcpServers: {},
  };

  const chosen = config.mode === 'mock' ? mockConfig : liveConfig;
  const mcpPath = path.join(ROOT, '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify(chosen, null, 2));
  console.log(`  .mcp.json synced for ${config.mode} mode`);
}

let connectingPromise: Promise<void> | null = null;

async function connectMCP() {
  // Deduplicate concurrent connection attempts
  if (connectingPromise) return connectingPromise;
  connectingPromise = _doConnect().finally(() => { connectingPromise = null; });
  return connectingPromise;
}

async function _doConnect() {
  syncMCPJson();

  // Close existing clients
  for (const c of [mcpClients.jira, mcpClients.confluence, mcpClients.zephyr]) {
    if (c !== mcpClients.jira || c === mcpClients.confluence) { // avoid double-close of same client
      await c?.close().catch(() => {});
    }
  }
  mcpClients = {}; mcpConnected = false;

  broadcast('status', { type: 'connecting', message: 'Connecting MCP…' });
  console.log(`\n  Connecting MCP servers (mode: ${config.mode})…`);

  if (config.mode === 'mock') {
    // Connect mock servers one at a time for clearer error messages
    try {
      console.log('  Starting mock-jira…');
      const jira = await startMockClient('mock-jira', 'src/mocks/jira-server.ts');
      console.log('  ✓ mock-jira');

      console.log('  Starting mock-confluence…');
      const confluence = await startMockClient('mock-confluence', 'src/mocks/confluence-server.ts');
      console.log('  ✓ mock-confluence');

      console.log('  Starting mock-zephyr…');
      const zephyr = await startMockClient('mock-zephyr', 'src/mocks/zephyr-server.ts');
      console.log('  ✓ mock-zephyr');

      mcpClients = { jira, confluence, zephyr };
    } catch (err) {
      console.error('  ✗ MCP connection failed:', err);
      broadcast('status', { type: 'error', message: `MCP failed: ${err}` });
      throw err;
    }
  } else {
    // Live mode uses direct REST APIs — no MCP processes needed
    console.log('  ✓ Live mode: using direct REST APIs (no MCP required)');
    mcpClients = {};
  }

  mcpConnected = true;
  console.log('  ✓ All MCP servers connected\n');
  broadcast('status', { type: 'connected', message: `Connected (${config.mode})` });
}

// ─── Generation: Claude Code mode ─────────────────────────────────────────────

/**
 * Run `claude --print "<prompt>"` as a child process in the project root.
 * Claude Code picks up .mcp.json and CLAUDE.md automatically.
 * Streams stdout line-by-line to the onChunk callback.
 */
function runViaClaudeCode(
  prompt: string,
  onChunk: (text: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    /**
     * Claude Code 2.x: pass prompt via stdin, use --print for non-interactive mode.
     * --dangerously-skip-permissions avoids interactive prompts blocking the process.
     * --output-format text gives clean plaintext output.
     */
    const child = spawn(
      'claude',
      ['--print', '--dangerously-skip-permissions', '--output-format', 'text'],
      {
        cwd: ROOT,
        env: { ...process.env, CLAUDE_NO_BROWSER: '1' },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    // Write prompt to stdin then close
    child.stdin.write(prompt);
    child.stdin.end();

    let full = '';
    let stderr = '';

    // 5 minute timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(
        'Claude Code timed out.\n' +
        'Make sure you are logged in — run: claude login  in the VS Code terminal.'
      ));
    }, 5 * 60 * 1000);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      full += text;
      onChunk(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Forward tool-call lines as info to the UI
      if (text.trim()) onChunk('\n🔧 ' + text.trim() + '\n');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(new Error(
          'Claude Code binary not found.\n' +
          'Install: npm install -g @anthropic-ai/claude-code\n' +
          'Or switch to Anthropic API mode in Config.'
        ));
      } else if (code === 'EACCES') {
        reject(new Error(
          `Permission denied: ${CLAUDE_BIN}\n` +
          `Fix with: chmod +x "${CLAUDE_BIN}"\n` +
          'Or switch to Anthropic API mode in Config.'
        ));
      } else {
        reject(new Error('Claude Code error: ' + err.message));
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      // Accept output even on non-zero exit if we got text back
      if (full.length > 0) {
        resolve(full);
      } else if (code === 0) {
        resolve('(No output returned)');
      } else {
        const hint = stderr.toLowerCase().includes('login') || stderr.toLowerCase().includes('auth')
          ? 'Run  claude login  in the VS Code terminal first.'
          : (stderr.slice(0, 300) || 'Run  claude login  in the VS Code terminal.');
        reject(new Error(`Claude Code failed (exit ${code}).\n${hint}`));
      }
    });
  });
}

// ─── Generation: OpenAI / Local (OpenAI-compatible) ──────────────────────────

async function runViaOpenAI(
  prompt: string,
  onChunk: (text: string) => void,
  isLocal = false
): Promise<string> {
  // Dynamic import so openai package is optional
  let OpenAI: typeof import('openai').default;
  try {
    ({ default: OpenAI } = await import('openai'));
  } catch {
    throw new Error(
      isLocal
        ? 'openai package required for local model. Run: npm install openai'
        : 'openai package not found. Run: npm install openai'
    );
  }

  const baseURL = isLocal ? config.localBaseUrl : undefined;
  const apiKey  = isLocal
    ? (config.localApiKey || 'local')
    : config.openaiApiKey;
  const model   = isLocal ? config.localModel : config.openaiModel;

  if (!isLocal && !apiKey) throw new Error('OpenAI API key not set. Add it in Config.');
  if (isLocal && !config.localBaseUrl) throw new Error('Local model URL not set. Add it in Config (e.g. http://localhost:11434/v1).');

  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

  const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');
  const systemPrompt = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf-8') : '';

  const stream = await client.chat.completions.create({
    model,
    max_tokens: 8096,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
  });

  let full = '';
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? '';
    if (text) { full += text; onChunk(text); }
  }
  return full;
}

// ─── Generation: API mode (Anthropic) ────────────────────────────────────────

async function runViaAPI(
  prompt: string,
  issueKey: string | undefined,
  onChunk: (text: string) => void,
  preloadedKbContext?: string  // passed from generate endpoint to avoid double-fetch
): Promise<string> {
  if (!mcpConnected) await connectMCP();

  const anthropic = new Anthropic({
    apiKey: config.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
  });
  const clients = [mcpClients.jira!, mcpClients.confluence!, mcpClients.zephyr!].filter(Boolean);
  const tools = await getAllMCPTools(...clients);

  const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');
  let systemPrompt = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf-8') : '';

  // Use pre-fetched KB context if provided, otherwise fetch now
  const kbCtx = preloadedKbContext ?? await (async () => {
    if (!issueKey) return '';
    try { return await retrieveLocalContextForIssue(db, issueKey, issueKey.split('-')[0]); }
    catch { return ''; }
  })();

  if (kbCtx) {
    systemPrompt += `\n\n---\n\n${kbCtx}`;
  }

  // ── Haiku routing: classify cheap tasks before generation ────────────────────
  const isComplexGeneration = prompt.includes('Generate') || prompt.includes('generate') || prompt.includes('test case');
  const generationModel = isComplexGeneration ? config.claudeModel : 'claude-haiku-4-5-20251001';

  // ── Build cached prefix: stable domain knowledge in cached block ───────────
  // System prompt (CLAUDE.md + KB context) is split:
  //   - Stable part (CLAUDE.md instructions) → cache_control: ephemeral (5 min)
  //   - Dynamic part (KB context) → regular content
  const claudeMdContent = fs.existsSync(path.join(ROOT, 'CLAUDE.md'))
    ? fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf-8')
    : '';

  // Build messages with cache control on the stable system prefix
  const messagesWithCache: Anthropic.MessageParam[] = [{
    role: 'user',
    content: [
      // Cached stable prefix: CLAUDE.md instructions
      {
        type: 'text' as const,
        text: claudeMdContent + (kbCtx ? `

---

${kbCtx}` : ''),
        cache_control: { type: 'ephemeral' },
      },
      // Dynamic tail: the actual prompt
      { type: 'text' as const, text: prompt },
    ],
  }];

  const messages: Anthropic.MessageParam[] = messagesWithCache;
  let fullText = '';

  for (let i = 0; i < 12; i++) {
    const response = await anthropic.messages.create({
      model: generationModel, max_tokens: 8096,
      system: [],
      messages, tools,
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      fullText += text; onChunk(text); break;
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'text' && block.text) onChunk(`\n_${block.text}_\n`);
        if (block.type !== 'tool_use') continue;

        broadcast('tool_call', { name: block.name, input: block.input });
        onChunk(`\n🔧 ${block.name}…\n`);

        try {
          const mc = block.name.startsWith('zephyr_') ? mcpClients.zephyr!
                   : block.name.startsWith('confluence_') ? mcpClients.confluence!
                   : mcpClients.jira!;
          const result = await mc.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result.content) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
  }
  return fullText;
}

// ─── Check Claude Code is available ──────────────────────────────────────────

function findClaudeBinary(): string {
  const home = process.env.HOME ?? '';

  // Priority 1: check PATH first (works after proper install or ~/.zshrc export)
  const whichResult = spawnSync('which', ['claude'], { encoding: 'utf-8', shell: true, timeout: 2000 });
  const whichPath = (whichResult.stdout ?? '').trim();
  if (whichPath && !whichPath.includes('not found') && fs.existsSync(whichPath)) {
    try { fs.chmodSync(whichPath, 0o755); } catch { /* ignore */ }
    console.log('  Claude binary (PATH):', whichPath);
    return whichPath;
  }

  // Priority 2: known npm global locations
  const npmCandidates = [
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, 'node_modules', '.bin', 'claude'),
  ];
  for (const p of npmCandidates) {
    if (fs.existsSync(p)) {
      try { fs.chmodSync(p, 0o755); } catch { /* ignore */ }
      console.log('  Claude binary (npm):', p);
      return p;
    }
  }

  // Priority 3: Claude desktop app — find actual MacOS executables (not wrappers)
  const claudeAppDir = path.join(home, 'Library', 'Application Support', 'Claude');
  if (fs.existsSync(claudeAppDir)) {
    // Look specifically inside .app/Contents/MacOS/ — that's the real executable
    const macOsResult = spawnSync('find', [
      claudeAppDir, '-path', '*/MacOS/claude', '-type', 'f'
    ], { encoding: 'utf-8', timeout: 5000 });
    const macOsPaths = (macOsResult.stdout ?? '').trim().split('\n').filter(Boolean);

    // Also look for claude binary directly (non-.app installs)
    const directResult = spawnSync('find', [
      claudeAppDir, '-name', 'claude', '-not', '-path', '*/.app/*', '-type', 'f'
    ], { encoding: 'utf-8', timeout: 5000 });
    const directPaths = (directResult.stdout ?? '').trim().split('\n').filter(Boolean);

    for (const p of [...macOsPaths, ...directPaths]) {
      if (!p) continue;
      try {
        const stat = fs.statSync(p);
        // Must be a file (not directory) and reasonably large (>1KB)
        if (stat.isFile() && stat.size > 1024) {
          fs.chmodSync(p, 0o755);
          console.log('  Claude binary (desktop app):', p);
          return p;
        }
      } catch { /* ignore */ }
    }
  }

  console.warn('  ⚠ Claude binary not found. Run: chmod +x $(which claude) or add claude to PATH');
  return 'claude';
}

const CLAUDE_BIN = findClaudeBinary();
console.log('  Claude binary:', CLAUDE_BIN);

async function checkClaudeCode(): Promise<{ available: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['--version'], { cwd: ROOT, shell: false });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES') resolve({ available: false, error: 'Permission denied — run: chmod +x "' + CLAUDE_BIN + '"' });
      else resolve({ available: false, error: 'claude not found — run: npm install -g @anthropic-ai/claude-code' });
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ available: true, version: out.trim() });
      else resolve({ available: false, error: 'claude exited with error — try: claude login' });
    });
  });
}

// ─── API Routes ────────────────────────────────────────────────────────────────

// Config
app.get('/api/config', (_req, res) => {
  const safe = { ...config };
  const mask = '••••••••';
  if (safe.jiraBearerToken) safe.jiraBearerToken = mask;
  if (safe.jiraApiToken) safe.jiraApiToken = mask;
  if (safe.confluenceApiToken) safe.confluenceApiToken = mask;
  if (safe.zephyrApiToken) safe.zephyrApiToken = mask;
  if (safe.anthropicApiKey) safe.anthropicApiKey = mask;
  res.json(safe);
});

app.post('/api/config', async (req, res) => {
  const inc = req.body as Partial<UIConfig>;
  const mask = '••••••••';
  // Migrate legacy claudeMode
  if (inc.claudeMode && !inc.aiProvider) {
    (inc as Partial<UIConfig>).aiProvider = (inc.claudeMode === 'api' ? 'anthropic' : inc.claudeMode) as UIConfig['aiProvider'];
  }
  config = {
    ...config, ...inc,
    jiraBearerToken:    inc.jiraBearerToken    === mask ? config.jiraBearerToken    : (inc.jiraBearerToken    ?? config.jiraBearerToken),
    jiraApiToken:       inc.jiraApiToken       === mask ? config.jiraApiToken       : (inc.jiraApiToken       ?? config.jiraApiToken),
    confluenceApiToken: inc.confluenceApiToken === mask ? config.confluenceApiToken : (inc.confluenceApiToken ?? config.confluenceApiToken),
    zephyrApiToken:     inc.zephyrApiToken     === mask ? config.zephyrApiToken     : (inc.zephyrApiToken     ?? config.zephyrApiToken),
    anthropicApiKey:    inc.anthropicApiKey    === mask ? config.anthropicApiKey    : (inc.anthropicApiKey    ?? config.anthropicApiKey),
    openaiApiKey:       inc.openaiApiKey       === mask ? config.openaiApiKey       : (inc.openaiApiKey       ?? config.openaiApiKey),
    localApiKey:        inc.localApiKey        === mask ? config.localApiKey        : (inc.localApiKey        ?? config.localApiKey),
  };
  const prevKbBackend = config.kbBackend;
  saveConfig(config);
  syncMCPJson(); // keep .mcp.json in sync whenever config changes

  // Hot-swap KB + approval store if backend changed
  if (config.kbBackend !== prevKbBackend) {
    console.log(`  Switching KB backend: ${prevKbBackend} → ${config.kbBackend}`);
    if ('disconnect' in db && typeof (db as any).disconnect === 'function') {
      await (db as any).disconnect().catch(() => {});
    }
    db = createKB();
    if ('disconnect' in approvalStore && typeof (approvalStore as any).disconnect === 'function') {
      await (approvalStore as any).disconnect().catch(() => {});
    }
    approvalStore = createApprovalStore({
      filePath: path.join(ROOT, 'approvals.json'),
      databaseUrl: config.databaseUrl || process.env.DATABASE_URL,
      kbBackend: config.kbBackend,
    });
    console.log(`  Approval store: ${approvalStore.backend}`);
  }

  res.json({ ok: true });
});

// Status
app.get('/api/status', async (_req, res) => {
  const ccCheck = await checkClaudeCode();
  const kbStatsRaw = db.getStats();
  const kbStats = kbStatsRaw instanceof Promise ? await kbStatsRaw : kbStatsRaw;
  res.json({
    mcpConnected,
    mode: config.mode,
    kbBackend: config.kbBackend ?? 'local',
    aiProvider: config.aiProvider ?? 'claudecode',
    claudeMode: config.aiProvider ?? 'claudecode',
    model: config.aiProvider === 'openai' ? config.openaiModel
         : config.aiProvider === 'local'  ? config.localModel
         : config.claudeModel,
    claudeCode: ccCheck,
    kb: kbStats,
  });
});

// Claude Code check
app.get('/api/claudecode/check', async (_req, res) => {
  res.json(await checkClaudeCode());
});

// Quick test: run `claude --print "Say OK"` and return result
app.post('/api/claudecode/test', async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (msg: string, done = false) =>
    res.write(`data: ${JSON.stringify({ message: msg, done })}

`);

  send('Running: claude --print "Say OK" ...');
  try {
    let out = '';
    await runViaClaudeCode('Say OK in exactly 2 words.', (chunk) => {
      out += chunk;
      send(chunk);
    });
    send(`Result: "${out.slice(0, 100)}"`, true);
    res.end();
  } catch (err) {
    send(`ERROR: ${String(err)}`, true);
    res.end();
  }
});

// Debug — shows server state and tsx path
app.get('/api/debug', async (_req, res) => {
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const tsxExists = fs.existsSync(tsxBin);
  const mockFiles = [
    'src/mocks/jira-server.ts',
    'src/mocks/confluence-server.ts',
    'src/mocks/zephyr-server.ts',
  ].map(f => ({ file: f, exists: fs.existsSync(path.join(ROOT, f)) }));

  const cc = await checkClaudeCode();

  res.json({
    ROOT,
    mode: config.mode,
    claudeMode: config.claudeMode,
    mcpConnected,
    tsx: { bin: tsxBin, exists: tsxExists },
    mockFiles,
    claudeCode: cc,
    nodeVersion: process.version,
    env: {
      PATH: process.env.PATH?.split(':').slice(0,8),
    },
  });
});

// ─── Direct REST API helpers (replaces mcp-atlassian and smartbear-mcp) ──────

function atlassianHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  if (config.jiraBearerToken) {
    h['Authorization'] = `Bearer ${config.jiraBearerToken}`;
  } else {
    const creds = Buffer.from(`${config.jiraUsername}:${config.jiraApiToken}`).toString('base64');
    h['Authorization'] = `Basic ${creds}`;
  }
  return h;
}

function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (n.type === 'text') return String(n.text ?? '');
  if (n.type === 'hardBreak') return '\n';
  const children = (Array.isArray(n.content) ? n.content : []).map((c: unknown) => adfToText(c)).join('');
  if (n.type === 'paragraph') return children + '\n';
  if (n.type === 'heading') return '## ' + children + '\n';
  if (n.type === 'listItem') return '- ' + children;
  if (n.type === 'codeBlock') return '```\n' + children + '\n```\n';
  return children;
}

function mapJiraIssue(raw: Record<string, unknown>): JiraIssue {
  const fields = (raw.fields ?? {}) as Record<string, unknown>;
  const desc = fields.description;
  return {
    key: String(raw.key ?? ''),
    summary: String((fields.summary as string) ?? ''),
    description: typeof desc === 'string' ? desc : (desc ? adfToText(desc) : undefined),
    priority: fields.priority as { name: string } | undefined,
    status: fields.status as { name: string } | undefined,
    labels: Array.isArray(fields.labels) ? fields.labels as string[] : [],
    components: Array.isArray(fields.components) ? fields.components as Array<{ name: string }> : [],
    assignee: fields.assignee as { displayName: string } | null | undefined,
  };
}

async function directJiraSearch(jql: string, maxResults = 30): Promise<JiraIssue[]> {
  const base = config.jiraUrl.replace(/\/$/, '');
  // Use POST /rest/api/3/search/jql (newer Atlassian Cloud API; GET /search is deprecated/410)
  const r = await fetch(`${base}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: atlassianHeaders(),
    body: JSON.stringify({ jql, maxResults, fields: ['summary', 'status', 'priority', 'assignee', 'labels', 'components', 'issuetype'] }),
  });
  if (!r.ok) throw new Error(`Jira search failed: ${r.status} ${r.statusText}`);
  const data = await r.json() as { issues: Array<Record<string, unknown>> };
  return (data.issues ?? []).map(mapJiraIssue);
}

async function directJiraIssue(key: string): Promise<JiraIssue> {
  const base = config.jiraUrl.replace(/\/$/, '');
  const r = await fetch(
    `${base}/rest/api/3/issue/${key}?fields=summary,description,status,priority,assignee,labels,components,issuetype,comment`,
    { headers: atlassianHeaders() }
  );
  if (!r.ok) throw new Error(`Jira issue ${key} failed: ${r.status} ${r.statusText}`);
  return mapJiraIssue(await r.json() as Record<string, unknown>);
}

async function directJiraComment(issueKey: string, comment: string): Promise<void> {
  const base = config.jiraUrl.replace(/\/$/, '');
  await fetch(`${base}/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: atlassianHeaders(),
    body: JSON.stringify({
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] }
    }),
  });
}

async function directConfluenceSearch(query: string): Promise<string> {
  const base = config.confluenceUrl.replace(/\/$/, '');
  const cql = config.confluenceSpaceKey
    ? `type=page AND space.key="${config.confluenceSpaceKey}" AND text ~ "${query}"`
    : `type=page AND text ~ "${query}"`;
  try {
    const r = await fetch(
      `${base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=5&expand=body.storage`,
      { headers: atlassianHeaders() }
    );
    if (!r.ok) return '';
    const data = await r.json() as { results: Array<Record<string, unknown>> };
    return (data.results ?? []).map((page: Record<string, unknown>) => {
      const title = String((page.title as string) ?? '');
      const body = ((page.body as Record<string, unknown>)?.storage as Record<string, unknown>)?.value as string ?? '';
      const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
      return `### ${title}\n${text}`;
    }).join('\n\n');
  } catch { return ''; }
}

function zephyrAuthHeader(): string {
  const token = config.zephyrApiToken.replace(/^Bearer\s+/i, '').trim();
  return `Bearer ${token}`;
}

async function directZephyrTestCases(issueKey: string): Promise<ZephyrTestCase[]> {
  const base = config.zephyrBaseUrl.replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/testcases?issueKey=${issueKey}&maxResults=50`, {
      headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json' },
    });
    if (!r.ok) return [];
    const data = await r.json() as { values?: ZephyrTestCase[] };
    return data.values ?? [];
  } catch { return []; }
}

async function directZephyrCreate(payload: Record<string, unknown>): Promise<{ key?: string }> {
  const base = config.zephyrBaseUrl.replace(/\/$/, '');
  const r = await fetch(`${base}/testcases`, {
    method: 'POST',
    headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Zephyr create failed: ${r.status} ${r.statusText}`);
  return r.json() as Promise<{ key?: string }>;
}

async function directZephyrLink(testCaseKey: string, issueKey: string): Promise<void> {
  const base = config.zephyrBaseUrl.replace(/\/$/, '');
  await fetch(`${base}/testcases/${testCaseKey}/links`, {
    method: 'POST',
    headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueId: issueKey }),
  });
}

// Connect MCP
app.post('/api/connect', async (_req, res) => {
  try { await connectMCP(); res.json({ ok: true, mode: config.mode }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── Individual connectivity tests ────────────────────────────────────────────

app.get('/api/test/jira', async (_req, res) => {
  try {
    const jql = config.jiraProjectKey ? `project = ${config.jiraProjectKey}` : 'ORDER BY created DESC';
    const issues = await directJiraSearch(jql, 1);
    res.json({ ok: true, detail: `Connected — ${issues.length > 0 ? `found ${issues[0].key}` : 'project accessible'}` });
  } catch (e: unknown) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/test/confluence', async (_req, res) => {
  try {
    const baseUrl = config.confluenceUrl.replace(/\/$/, '');
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (config.jiraBearerToken) {
      headers['Authorization'] = `Bearer ${config.jiraBearerToken}`;
    } else {
      const creds = Buffer.from(`${config.confluenceUsername}:${config.confluenceApiToken}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
    }
    const r = await fetch(`${baseUrl}/rest/api/space?limit=1`, { headers });
    if (!r.ok) return res.json({ ok: false, error: `HTTP ${r.status} ${r.statusText}` });
    res.json({ ok: true, detail: 'Connected' });
  } catch (e: unknown) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/test/zephyr', async (_req, res) => {
  try {
    const baseUrl = config.zephyrBaseUrl.replace(/\/$/, '');
    const r = await fetch(`${baseUrl}/projects?maxResults=1`, {
      headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json' },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.json({ ok: false, error: `HTTP ${r.status} ${r.statusText}${body ? ': ' + body.slice(0, 200) : ''}` });
    }
    res.json({ ok: true, detail: 'Connected' });
  } catch (e: unknown) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Jira
app.get('/api/jira/issues', async (req, res) => {
  try {
    if (config.mode === 'mock') {
      if (!mcpConnected) await connectMCP();
      const defaultJql = config.jiraProjectKey
        ? `project = ${config.jiraProjectKey} ORDER BY created DESC`
        : 'ORDER BY created DESC';
      const jql = (req.query.jql as string) || defaultJql;
      const result = await mcpClients.jira!.callTool({ name: 'jira_search', arguments: { jql, max_results: 30 } });
      const text = (result.content as Array<{text:string}>)[0]?.text ?? '[]';
      return res.json(JSON.parse(text));
    }
    const defaultJql = config.jiraProjectKey
      ? `project = ${config.jiraProjectKey} ORDER BY created DESC`
      : 'ORDER BY created DESC';
    const jql = (req.query.jql as string) || defaultJql;
    res.json(await directJiraSearch(jql));
  } catch (err) {
    console.error('/api/jira/issues error:', err);
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/jira/issue/:key', async (req, res) => {
  try {
    if (config.mode === 'mock') {
      if (!mcpConnected) await connectMCP();
      const result = await mcpClients.jira!.callTool({ name: 'jira_get_issue', arguments: { issue_key: req.params.key } });
      return res.json(JSON.parse((result.content as Array<{text:string}>)[0]?.text ?? '{}'));
    }
    res.json(await directJiraIssue(req.params.key));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Zephyr
app.get('/api/zephyr/testcases/:issueKey', async (req, res) => {
  try {
    if (config.mode === 'mock') {
      if (!mcpConnected) await connectMCP();
      const result = await mcpClients.zephyr!.callTool({ name: 'zephyr_get_test_cases_by_issue', arguments: { issueKey: req.params.issueKey } });
      return res.json(JSON.parse((result.content as Array<{text:string}>)[0]?.text ?? '[]'));
    }
    res.json(await directZephyrTestCases(req.params.issueKey));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─── Jira write-back ─────────────────────────────────────────────────────────

app.post('/api/jira/comment', async (req, res) => {
  const { issueKey, comment } = req.body as { issueKey: string; comment: string };
  try {
    if (config.mode === 'mock') {
      if (!mcpConnected) await connectMCP();
      const result = await mcpClients.jira!.callTool({ name: 'jira_add_comment', arguments: { issue_key: issueKey, comment } });
      const text = (result.content as Array<{text:string}>)[0]?.text ?? '{}';
      return res.json(JSON.parse(text));
    }
    await directJiraComment(issueKey, comment);
    res.json({ ok: true });
  } catch (err) {
    console.error('Jira comment failed:', err);
    res.status(500).json({ error: String(err) });
  }
});

// ─── Approval API ─────────────────────────────────────────────────────────────

// Create a new approval request
app.post('/api/approvals', async (req, res) => {
  const { issueKey, issueSummary, projectKey, folder, requestedBy, testCases } = req.body;
  const id = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const approval = {
    id, issueKey, issueSummary: issueSummary || issueKey,
    projectKey: projectKey || issueKey.split('-')[0],
    folder: folder || 'Generated',
    requestedBy: requestedBy || 'unknown',
    requestedAt: new Date().toISOString(),
    testCases: (testCases as any[]).map((tc, i) => ({ ...tc, id: i })),
    status: 'pending',
  };
  await approvalStore.save(approval);
  console.log(`  Approval request created: ${id} (${testCases.length} tests for ${issueKey}) [${approvalStore.backend}]`);
  res.json({ id, url: `/approve/${id}` });
});

// Get all approval requests
app.get('/api/approvals', async (_req, res) => {
  res.json(await approvalStore.loadAll());
});

// Get a single approval request
app.get('/api/approvals/:id', async (req, res) => {
  const apr = await approvalStore.load(req.params.id);
  if (!apr) return res.status(404).json({ error: 'Approval request not found' });
  res.json(apr);
});

// Teammate submits their review (approve/reject each test + name)
app.post('/api/approvals/:id/review', async (req, res) => {
  const apr = await approvalStore.load(req.params.id);
  if (!apr) return res.status(404).json({ error: 'Not found' });
  if (apr.status === 'uploaded') return res.status(400).json({ error: 'Already uploaded' });

  const { approverName, decisions } = req.body as {
    approverName: string;
    decisions: Array<{ id: number; approved: boolean; comment?: string }>;
  };

  // Apply decisions to test cases
  for (const d of decisions) {
    const tc = apr.testCases.find(t => t.id === d.id);
    if (tc) {
      tc.approved = d.approved;
      tc.rejected = !d.approved;
      tc.approverComment = d.comment ?? '';
    }
  }

  const approvedCount = apr.testCases.filter(t => t.approved).length;
  const rejectedCount = apr.testCases.filter(t => t.rejected).length;

  apr.approvedBy = approverName;
  apr.approvedAt = new Date().toISOString();
  apr.status = approvedCount === 0 ? 'rejected'
    : rejectedCount === 0 ? 'approved'
    : 'partial';

  await approvalStore.save(apr);
  broadcast('approval_reviewed', { id: apr.id, status: apr.status, approvedBy: approverName, approvedCount, rejectedCount });
  console.log(`  Approval ${apr.id} reviewed by ${approverName}: ${approvedCount} approved, ${rejectedCount} rejected`);
  res.json({ ok: true, status: apr.status, approvedCount, rejectedCount });
});

// Upload approved tests to Zephyr + KB + post Jira comment
app.post('/api/approvals/:id/upload', async (req, res) => {
  const apr = await approvalStore.load(req.params.id);
  if (!apr) return res.status(404).json({ error: 'Not found' });
  if (!['approved', 'partial'].includes(apr.status)) {
    return res.status(400).json({ error: `Cannot upload — status is ${apr.status}. Needs approval first.` });
  }

  if (!mcpConnected) await connectMCP();

  const toUpload = apr.testCases.filter(t => t.approved);
  if (!toUpload.length) return res.status(400).json({ error: 'No approved test cases to upload' });

  const uploadedKeys: string[] = [];
  const failed: string[] = [];

  // 1. Upload each approved test to Zephyr
  for (const tc of toUpload) {
    try {
      const payload: Record<string, unknown> = {
        projectKey: apr.projectKey,
        name: tc.name,
        objective: tc.content.slice(0, 500),
        precondition: tc.precondition || 'See test case details',
        priority: tc.priority || 'Medium',
        folder: apr.folder || 'Generated',
        labels: ['approved', 'test-agent', apr.issueKey.toLowerCase()],
        testScript: {
          type: 'STEP_BY_STEP',
          steps: tc.steps?.length > 0 ? tc.steps : [
            { description: 'Execute as described', expectedResult: tc.outcome || 'Test passes' }
          ],
        },
      };
      const created = config.mode === 'mock'
        ? JSON.parse(((await mcpClients.zephyr!.callTool({ name: 'zephyr_create_test_case', arguments: payload })).content as Array<{text:string}>)[0]?.text ?? '{}').created
        : await directZephyrCreate(payload);
      if (created?.key) {
        uploadedKeys.push(created.key);
        if (config.mode === 'live') {
          await directZephyrLink(created.key, apr.issueKey).catch(e =>
            console.warn(`  Zephyr link failed for ${created.key} → ${apr.issueKey}:`, e)
          );
        }
      }
    } catch (err) {
      failed.push(tc.name);
      console.error(`Failed to upload "${tc.name}":`, err);
    }
  }

  // 2. Save each uploaded test to KB individually (unique ID per test)
  let kbSavedCount = 0;
  for (let ki = 0; ki < uploadedKeys.length; ki++) {
    const tc = toUpload[ki];
    if (!tc) continue;
    try {
      const doc = formatTestCaseDocument(tc.content, {
        jiraIssueKey: apr.issueKey,
        approvedBy: apr.approvedBy ?? 'approved',
        projectKey: apr.projectKey,
        featureArea: tc.type ?? '',
        component: '',
      });
      // Make ID unique per test case using Zephyr key
      doc.id = `generated:${uploadedKeys[ki]}:${apr.issueKey}`;
      await db.addDocument(doc);
      kbSavedCount++;
    } catch (e) {
      console.warn(`KB save failed for ${uploadedKeys[ki]}:`, e);
    }
  }
  console.log(`  KB: ${kbSavedCount}/${uploadedKeys.length} test cases saved`);

  // 3. Post comment back to Jira
  if (uploadedKeys.length > 0) {
    const tcLines = toUpload
      .filter((_, i) => i < uploadedKeys.length)
      .map((tc, i) => `- *${uploadedKeys[i]}* — ${tc.name}`)
      .join('\n');

    const comment = `✅ *Test cases approved and uploaded to Zephyr Scale*

Approved by: *${apr.approvedBy}* on ${new Date(apr.approvedAt!).toLocaleDateString()}
Requested by: ${apr.requestedBy}

*Uploaded test cases (${uploadedKeys.length}):*
${tcLines}

All test cases have been added to the team Knowledge Base for future reference.`;

    try {
      if (config.mode === 'mock') {
        await mcpClients.jira!.callTool({ name: 'jira_add_comment', arguments: { issue_key: apr.issueKey, comment } });
      } else {
        await directJiraComment(apr.issueKey, comment);
      }
      console.log(`  Jira comment posted to ${apr.issueKey}`);
    } catch (err) {
      console.warn(`  Jira comment failed (non-fatal):`, err);
    }
  }

  // 4. Mark approval as uploaded
  apr.status = 'uploaded';
  apr.uploadedAt = new Date().toISOString();
  apr.zephyrKeys = uploadedKeys;
  await approvalStore.save(apr);

  broadcast('approval_uploaded', { id: apr.id, uploadedKeys, issueKey: apr.issueKey });

  res.json({
    ok: true,
    uploadedCount: uploadedKeys.length,
    failedCount: failed.length,
    zephyrKeys: uploadedKeys,
    kbSaved: kbSavedCount > 0,
    kbSavedCount,
    jiraCommentPosted: uploadedKeys.length > 0,
  });
});

// Delete an approval request
app.delete('/api/approvals/:id', async (req, res) => {
  await approvalStore.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/zephyr/create', async (req, res) => {
  try {
    if (config.mode === 'mock') {
      if (!mcpConnected) await connectMCP();
      const result = await mcpClients.zephyr!.callTool({ name: 'zephyr_create_test_case', arguments: req.body });
      return res.json(JSON.parse((result.content as Array<{text:string}>)[0]?.text ?? '{}'));
    }
    const { projectKey, name, objective, precondition, priority, folder, labels, steps } = req.body;
    const payload: Record<string, unknown> = {
      projectKey, name,
      objective: objective?.slice(0, 500),
      precondition: precondition || '',
      priority: priority || 'Medium',
      folder: folder || 'Generated',
      labels: labels || ['auto-generated'],
    };
    if (steps && Array.isArray(steps) && steps.length > 0) {
      payload.testScript = { type: 'STEP_BY_STEP', steps };
    }
    const created = await directZephyrCreate(payload);
    res.json({ created });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─── Generate (SSE stream) ────────────────────────────────────────────────────

app.post('/api/generate', async (req, res) => {
  const { issueKey, prompt: customPrompt } = req.body as { issueKey?: string; prompt?: string };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // ── 1. Pre-fetch Jira + Confluence + Zephyr context directly ────────────────────
  let issueContext = '';
  let confluenceContext = '';
  let existingTestsContext = '';

  if (issueKey && config.mode === 'live') {
    try {
      const issue = await directJiraIssue(issueKey);
      issueContext = [
        `**Summary:** ${issue.summary}`,
        issue.description ? `**Description:**\n${issue.description}` : '',
        issue.priority ? `**Priority:** ${issue.priority.name}` : '',
        issue.status ? `**Status:** ${issue.status.name}` : '',
        issue.labels?.length ? `**Labels:** ${issue.labels.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    } catch (e) { console.log(`  Jira fetch skipped: ${e}`); }

    try {
      const summary = issueContext.split('\n')[0].replace('**Summary:** ', '');
      confluenceContext = await directConfluenceSearch(summary || issueKey);
      if (confluenceContext) console.log(`  Confluence: found related pages`);
    } catch (e) { console.log(`  Confluence fetch skipped: ${e}`); }

    try {
      const existing = await directZephyrTestCases(issueKey);
      if (existing.length > 0) {
        existingTestsContext = `Existing test cases (${existing.length}):\n` +
          existing.map(t => `- ${t.key}: ${t.name}`).join('\n');
        console.log(`  Zephyr: ${existing.length} existing tests found`);
      }
    } catch (e) { console.log(`  Zephyr fetch skipped: ${e}`); }
  } else if (issueKey && config.mode === 'mock') {
    try {
      if (!mcpConnected) await connectMCP();
      const issueResult = await mcpClients.jira?.callTool({ name: 'jira_get_issue', arguments: { issue_key: issueKey } });
      const issueText = (issueResult?.content as Array<{text:string}>)?.[0]?.text ?? '';
      if (issueText) issueContext = issueText.slice(0, 3000);
    } catch { /* continue without live data */ }
  }

  // ── 2. Retrieve KB context for this issue ────────────────────────────────────
  let kbContext = '';
  if (issueKey) {
    try {
      const kbResults = await retrieveLocalContextForIssue(
        db,
        issueKey,
        issueKey.split('-')[0],
        undefined
      );
      if (kbResults) {
        kbContext = kbResults;
        // Count approx number of KB docs retrieved
        const docCount = (kbResults.match(/Relevance:/g) || []).length;
        send({ type: 'kb_context', count: docCount, message: `KB: ${docCount} relevant docs found` });
        console.log(`  KB context: ${docCount} docs for ${issueKey}`);
      } else {
        console.log(`  KB context: none found for ${issueKey} (run kb:local:seed to populate)`);
      }
    } catch (e) {
      console.log(`  KB context: skipped (${e})`);
    }
  }

  // ── 3. Build prompt with all context ─────────────────────────────────────────
  const contextBlock = [
    issueContext         ? `## Jira Issue: ${issueKey}\n${issueContext}` : '',
    confluenceContext    ? `## Confluence Documentation\n${confluenceContext}` : '',
    existingTestsContext ? `## Existing Zephyr Tests\n${existingTestsContext}` : '',
    kbContext            ? `## Related Knowledge Base Context\n${kbContext}` : '',
  ].filter(Boolean).join('\n\n');

  const prompt = customPrompt ?? (
    issueKey
      ? `Generate comprehensive test cases for Jira issue ${issueKey}.\n\n` +
        (contextBlock
          ? `The following context has been pre-loaded — do NOT make additional tool calls for Jira or Confluence, use this context directly:\n\n${contextBlock}\n\n`
          : '') +
        `Generate test cases covering all acceptance criteria, edge cases, and negative tests. ` +
        `Avoid duplicating any existing Zephyr tests or KB patterns listed above. ` +
        `Follow the structure in CLAUDE.md.`
      : 'Help me generate test cases.'
  );

  try {
    let fullOutput = '';
    const provider = config.aiProvider ?? (config.claudeMode === 'api' ? 'anthropic' : 'claudecode');

    if (provider === 'claudecode') {
      send({ type: 'mode', engine: 'Claude Code' });
      fullOutput = await runViaClaudeCode(prompt, chunk => send({ type: 'chunk', text: chunk }));

    } else if (provider === 'anthropic') {
      send({ type: 'mode', engine: 'Anthropic API' });
      fullOutput = await runViaAPI(prompt, issueKey,
        chunk => send({ type: 'chunk', text: chunk }),
        kbContext
      );

    } else if (provider === 'openai') {
      send({ type: 'mode', engine: `OpenAI (${config.openaiModel})` });
      fullOutput = await runViaOpenAI(prompt, chunk => send({ type: 'chunk', text: chunk }), false);

    } else if (provider === 'local') {
      send({ type: 'mode', engine: `Local (${config.localModel})` });
      fullOutput = await runViaOpenAI(prompt, chunk => send({ type: 'chunk', text: chunk }), true);

    } else {
      throw new Error(`Unknown provider: ${provider}. Choose claudecode, anthropic, openai, or local.`);
    }

    // Auto-save to KB if enabled
    if (config.autoSaveToKB && fullOutput && issueKey) {
      const doc = formatTestCaseDocument(fullOutput, {
        jiraIssueKey: issueKey, approvedBy: 'auto',
        projectKey: issueKey.split('-')[0],
      });
      await db.addDocument(doc);
      send({ type: 'kb_saved', message: 'Auto-saved to Knowledge Base' });
    }

    send({ type: 'done', fullOutput });
  } catch (err) {
    send({ type: 'error', message: String(err) });
  }

  res.end();
});

// KB endpoints
app.get('/api/kb/stats', async (_req, res) => { res.json(db.getStats()); });
app.get('/api/kb/list',  async (_req, res) => { res.json(await db.listIds()); });

app.post('/api/kb/save', async (req, res) => {
  const { content, issueKey, approvedBy } = req.body as { content: string; issueKey: string; approvedBy: string };
  try {
    await db.addDocument(formatTestCaseDocument(content, {
      jiraIssueKey: issueKey, approvedBy: approvedBy || 'user',
      projectKey: issueKey.split('-')[0],
    }));
    res.json({ ok: true, stats: db.getStats() });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/kb/seed', async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (msg: string, done = false) =>
    res.write(`data: ${JSON.stringify({ message: msg, done })}\n\n`);

  send('Clearing KB…');
  await db.clear();
  const child = spawn('npx', ['tsx', 'src/local-kb/seed.ts'], { cwd: ROOT, env: process.env });
  child.stdout.on('data', (d: Buffer) => send(d.toString().trim()));
  child.stderr.on('data', (d: Buffer) => send(d.toString().trim()));
  child.on('close', () => { send('Seed complete ✓', true); res.end(); });
});

app.delete('/api/kb/clear', async (_req, res) => {
  await db.clear(); res.json({ ok: true });
});

// ─── Approval page (shareable link for teammates) ────────────────────────────

app.get('/approve/:id', (req, res) => {
  // Serve approval page — check both build output and source locations
  const locations = [
    path.join(__dirname, 'public', 'approve.html'),          // built location
    path.join(ROOT, 'ui', 'client', 'public', 'approve.html'), // source location
    path.join(ROOT, 'ui', 'public', 'approve.html'),          // legacy location
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) { res.sendFile(loc); return; }
  }
  res.status(404).send('approve.html not found. Run: npm run ui:build');
});

// API: get approval data for the approval page
app.get('/api/approvals/:id/data', async (req, res) => {
  const apr = await approvalStore.load(req.params.id);
  if (!apr) return res.status(404).json({ error: 'Approval request not found' });
  res.json(apr);
});


// Fallback → serve UI
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
const HOST = '0.0.0.0'; // bind to all interfaces so teammates can connect
const SERVER_IP = process.env.SERVER_IP ?? '10.105.217.140';

httpServer.listen(Number(PORT), HOST, async () => {
  console.log(`\n${'━'.repeat(58)}`);
  console.log(`  Selfridges Test Management Agent`);
  console.log('━'.repeat(58));
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${SERVER_IP}:${PORT}  ← share with teammates`);
  console.log('━'.repeat(58));
  syncMCPJson();

  const cc = await checkClaudeCode();
  if (cc.available) {
    console.log(`  ✓ Claude Code ${cc.version} — ready`);
  } else {
    console.log(`  ⚠ Claude Code not found — run: claude login`);
  }
  console.log('━'.repeat(58) + '\n');

  connectMCP().catch(e => console.error('MCP connect error:', e));
});
