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
import { LocalKnowledgeBase, retrieveLocalContextForIssue, type KBScope } from '../src/local-kb/local-vector-db.js';
import { PgKnowledgeBase } from '../src/kb/pg-vector-db.js';
import type { IKnowledgeBase } from '../src/kb/interface.js';
import { formatTestCaseDocument, formatZephyrDocument } from '../src/knowledge-base/formatters.js';
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

// ─── KB Backend — EC2/pgvector is default; local JSON is fallback only ────────
function createKB(): IKnowledgeBase {
  const dbUrl = buildDbUrl(config.databaseUrl || process.env.DATABASE_URL, config.dbName || process.env.DB_NAME);
  const apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (dbUrl && apiKey) {
    console.log('  KB backend: pgvector (EC2)');
    return new PgKnowledgeBase(dbUrl, apiKey);
  }
  if (dbUrl && !apiKey) {
    console.warn('  ⚠ DATABASE_URL set but ANTHROPIC_API_KEY missing — falling back to local KB');
  }
  console.log('  KB backend: local JSON (fallback)');
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
  jiraEpicKey: string;       // optional — if set, only load issues from this epic
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
  databaseUrl: string;  // base URL without dbname, e.g. postgresql://user:pass@host:5432
  dbName: string;       // database name — appended to databaseUrl to form the full connection string
  kbScopeMode: 'project' | 'multi' | 'all';  // KB retrieval scope during generation
  kbScopeProjects: string[];                  // projects to include when mode is 'multi'
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
    mode: 'live',
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
    jiraEpicKey: process.env.JIRA_EPIC_KEY ?? '',
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
    kbBackend: process.env.DATABASE_URL ? 'pgvector' : 'local',
    databaseUrl: process.env.DATABASE_URL ?? '',
    dbName: process.env.DB_NAME ?? '',
    kbScopeMode: 'project',
    kbScopeProjects: [],
  };
}

// Builds the full PostgreSQL connection string from base URL + dbName field.
// If databaseUrl already contains a path (dbname), dbName overrides it.
function buildDbUrl(baseUrl?: string, dbName?: string): string {
  const url = (baseUrl || '').trim();
  if (!url) return '';
  const name = (dbName || '').trim();
  if (!name) return url;
  try {
    const u = new URL(url);
    u.pathname = '/' + name;
    return u.toString();
  } catch {
    // Not a valid URL — append as-is
    return url.replace(/\/[^/]*$/, '') + '/' + name;
  }
}

function saveConfig(c: UIConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

let config = loadConfig();

// Now config is loaded — safe to create KB and approval store
db = createKB();
approvalStore = createApprovalStore({
  filePath: path.join(ROOT, 'approvals.json'),
  databaseUrl: buildDbUrl(config.databaseUrl || process.env.DATABASE_URL, config.dbName || process.env.DB_NAME) || undefined,
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
  preloadedKbContext?: string
): Promise<string> {
  const anthropic = new Anthropic({
    apiKey: config.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
  });

  const kbCtx = preloadedKbContext ?? await (async () => {
    if (!issueKey) return '';
    try { return await retrieveLocalContextForIssue(db, issueKey, issueKey.split('-')[0], undefined, { mode: config.kbScopeMode ?? 'project', projects: config.kbScopeProjects }); }
    catch { return ''; }
  })();

  const isComplexGeneration = prompt.includes('Generate') || prompt.includes('generate') || prompt.includes('test case');
  const generationModel = isComplexGeneration ? config.claudeModel : 'claude-haiku-4-5-20251001';

  const claudeMdContent = fs.existsSync(path.join(ROOT, 'CLAUDE.md'))
    ? fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf-8')
    : '';

  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: [
      {
        type: 'text' as const,
        text: claudeMdContent + (kbCtx ? `\n\n---\n\n${kbCtx}` : ''),
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text' as const, text: prompt },
    ],
  }];

  const response = await anthropic.messages.create({
    model: generationModel, max_tokens: 8096,
    system: [],
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  onChunk(text);
  return text;
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
  const prevDbUrl = (config as any)._prevDbUrl ?? '';
  (config as any)._prevDbUrl = config.databaseUrl || process.env.DATABASE_URL || '';
  saveConfig(config);
  syncMCPJson(); // keep .mcp.json in sync whenever config changes

  // Hot-swap KB + approval store if database config changed
  const newDbUrl = buildDbUrl(config.databaseUrl || process.env.DATABASE_URL, config.dbName || process.env.DB_NAME);
  if (newDbUrl !== prevDbUrl) {
    console.log(`  Switching KB backend due to database config change`);
    if ('disconnect' in db && typeof (db as any).disconnect === 'function') {
      await (db as any).disconnect().catch(() => {});
    }
    db = createKB();
    if ('disconnect' in approvalStore && typeof (approvalStore as any).disconnect === 'function') {
      await (approvalStore as any).disconnect().catch(() => {});
    }
    approvalStore = createApprovalStore({
      filePath: path.join(ROOT, 'approvals.json'),
      databaseUrl: newDbUrl || undefined,
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
    kbBackend: (config.databaseUrl || process.env.DATABASE_URL) ? 'pgvector' : 'local',
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

function adfToText(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;

  // Leaf nodes
  if (n.type === 'text') {
    let t = String(n.text ?? '');
    const marks = Array.isArray(n.marks) ? n.marks as Array<{type:string}> : [];
    if (marks.some(m => m.type === 'strong')) t = `**${t}**`;
    if (marks.some(m => m.type === 'em')) t = `_${t}_`;
    if (marks.some(m => m.type === 'code')) t = `\`${t}\``;
    return t;
  }
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'rule') return '\n---\n';

  const content = Array.isArray(n.content) ? n.content as unknown[] : [];

  // Ordered list — number each listItem
  if (n.type === 'orderedList') {
    return content.map((item, i) => {
      const c = (item as Record<string,unknown>);
      const inner = (Array.isArray(c.content) ? c.content as unknown[] : [])
        .map(ch => adfToText(ch, depth + 1)).join('').replace(/\n$/, '');
      return `${i + 1}. ${inner}\n`;
    }).join('');
  }

  const children = content.map(c => adfToText(c, depth + 1)).join('');

  switch (n.type) {
    case 'paragraph':   return children + '\n';
    case 'heading': {
      const lvl = typeof n.attrs === 'object' && n.attrs ? (n.attrs as any).level ?? 2 : 2;
      return '#'.repeat(lvl) + ' ' + children + '\n';
    }
    case 'bulletList':  return children;
    case 'listItem':    return '  '.repeat(depth) + '- ' + children.replace(/\n$/, '') + '\n';
    case 'blockquote':  return children.split('\n').map(l => '> ' + l).join('\n') + '\n';
    case 'codeBlock':   return '```\n' + children + '\n```\n';
    case 'panel':       return children;   // info/note/warning panels
    case 'expand':      return children;
    case 'table':       return children + '\n';
    case 'tableRow':    return children + '\n';
    case 'tableHeader': return `| ${children.trim()} `;
    case 'tableCell':   return `| ${children.trim()} `;
    default:            return children;
  }
}

function mapJiraIssue(raw: Record<string, unknown>): JiraIssue {
  const fields = (raw.fields ?? {}) as Record<string, unknown>;
  const desc = fields.description;
  let description = typeof desc === 'string' ? desc : (desc ? adfToText(desc) : '');

  // Scan custom fields for acceptance criteria content
  const acParts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith('customfield_') || !v) continue;
    if (typeof v === 'string' && v.trim().length > 10) {
      acParts.push(v.trim());
    } else if (typeof v === 'object' && (v as any).type === 'doc') {
      const text = adfToText(v);
      if (text.trim()) acParts.push(text.trim());
    }
  }
  if (acParts.length > 0) {
    description = (description ? description + '\n\n' : '') +
      '### Custom Fields\n' + acParts.join('\n\n');
  }

  console.log(`  [Jira] ${raw.key} description length: ${description?.length ?? 0} chars`);

  return {
    id: raw.id ? String(raw.id) : undefined,
    key: String(raw.key ?? ''),
    summary: String((fields.summary as string) ?? ''),
    description: description || undefined,
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
  // Fetch all fields so custom acceptance-criteria fields are included
  const r = await fetch(
    `${base}/rest/api/3/issue/${key}?expand=renderedFields`,
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
    const projectKey = config.jiraProjectKey || '';
    // Fetch up to 500 — issueKey filter is ignored by some Zephyr instances so we filter server-side
    const url = `${base}/testcases?projectKey=${projectKey}&issueKey=${issueKey}&maxResults=500`;
    const r = await fetch(url, {
      headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json' },
    });
    if (!r.ok) {
      console.warn(`[Zephyr] testcases for ${issueKey}: ${r.status}`);
      return [];
    }
    const data = await r.json() as { values?: ZephyrTestCase[]; total?: number };
    const all = data.values ?? [];

    // Filter to only tests that belong to this issue.
    // We label every generated test with the lowercase issueKey (e.g. "qap-2"),
    // and Zephyr may also populate linkedIssues. Either signals ownership.
    const issueKeyLower = issueKey.toLowerCase();
    const filtered = all.filter(t =>
      t.linkedIssues?.includes(issueKey) ||
      t.labels?.some(l => l.toLowerCase() === issueKeyLower)
    );

    console.log(`[Zephyr] testcases for ${issueKey}: ${all.length} total, ${filtered.length} matched`);
    return filtered;
  } catch { return []; }
}

async function directZephyrAllTestCases(projectKey: string): Promise<ZephyrTestCase[]> {
  const base = config.zephyrBaseUrl.replace(/\/$/, '');
  const all: ZephyrTestCase[] = [];
  let startAt = 0;
  const pageSize = 100;

  while (true) {
    const url = `${base}/testcases?projectKey=${projectKey}&maxResults=${pageSize}&startAt=${startAt}`;
    const r = await fetch(url, {
      headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json' },
    });
    if (!r.ok) { console.warn(`[Zephyr] bulk fetch page startAt=${startAt}: ${r.status}`); break; }
    const data = await r.json() as { values?: ZephyrTestCase[]; total?: number };
    const values = data.values ?? [];
    all.push(...values);
    if (values.length < pageSize || all.length >= (data.total ?? 0)) break;
    startAt += pageSize;
  }
  return all;
}

function mapZephyrPriority(priority: string): string {
  const p = priority.toLowerCase();
  if (p === 'critical' || p === 'high') return 'High';
  if (p === 'low') return 'Low';
  return 'Normal';
}

async function directZephyrSetIssueLink(testCaseKey: string, jiraIssueIdOrKey: string): Promise<void> {
  const base = config.zephyrBaseUrl.replace(/\/$/, '');
  // Zephyr requires numeric issueId; if we have the numeric id use it, otherwise fall back to key
  const issueId = /^\d+$/.test(jiraIssueIdOrKey) ? Number(jiraIssueIdOrKey) : jiraIssueIdOrKey;
  const r = await fetch(`${base}/testcases/${testCaseKey}/links/issues`, {
    method: 'POST',
    headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueId }),
  });
  const body = await r.text().catch(() => '');
  console.log(`  [Zephyr] POST /testcases/${testCaseKey}/links/issues issueId=${issueId}: ${r.status} ${body.slice(0, 200)}`);
}

async function directZephyrCreate(payload: Record<string, unknown>): Promise<{ key?: string }> {
  const base = config.zephyrBaseUrl.replace(/\/$/, '');
  const r = await fetch(`${base}/testcases`, {
    method: 'POST',
    headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Zephyr create failed: ${r.status} ${r.statusText}`);
  const created = await r.json() as Record<string, unknown>;
  console.log(`  [Zephyr] CREATE response issueLinks:`, JSON.stringify(created.issueLinks), 'key:', created.key);
  return created as { key?: string };
}

async function directZephyrAddSteps(
  testCaseKey: string,
  steps: Array<{ description: string; expectedResult: string }>
): Promise<void> {
  const base = config.zephyrBaseUrl.replace(/\/$/, '');
  const body = {
    mode: 'OVERWRITE',
    items: steps.map(s => ({
      inline: {
        description: s.description,
        testData: '',
        expectedResult: s.expectedResult,
      },
    })),
  };
  const r = await fetch(`${base}/testcases/${testCaseKey}/teststeps`, {
    method: 'POST',
    headers: { 'Authorization': zephyrAuthHeader(), 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.warn(`  Zephyr steps for ${testCaseKey}: ${r.status} ${text}`);
  }
}


// Connect MCP
app.post('/api/connect', async (_req, res) => {
  try { await connectMCP(); res.json({ ok: true, mode: config.mode }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

function defaultJiraJql(): string {
  if (config.jiraEpicKey) {
    // Filter to issues whose parent is the epic (Jira Cloud company-managed and next-gen)
    const base = `"Epic Link" = ${config.jiraEpicKey} OR parent = ${config.jiraEpicKey}`;
    return config.jiraProjectKey ? `project = ${config.jiraProjectKey} AND (${base})` : base;
  }
  return config.jiraProjectKey
    ? `project = ${config.jiraProjectKey} ORDER BY created DESC`
    : 'ORDER BY created DESC';
}

// ── Individual connectivity tests ────────────────────────────────────────────

app.get('/api/test/jira', async (_req, res) => {
  try {
    const issues = await directJiraSearch(defaultJiraJql(), 1);
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

app.get('/api/test/db', async (_req, res) => {
  const baseUrl = (config.databaseUrl || process.env.DATABASE_URL || '').trim();
  const dbName  = (config.dbName || process.env.DB_NAME || '').trim();
  if (!baseUrl) return res.json({ ok: false, steps: [], error: 'No Database URL configured.' });

  const steps: Array<{ label: string; ok: boolean; detail?: string }> = [];
  const { default: postgres } = await import('postgres');
  const ssl = process.env.DB_SSL === 'require' ? ('require' as const) : false;
  const opts = { ssl, max: 1, connect_timeout: 10, idle_timeout: 5 };

  // Step 1: host reachable — connect to the target db; distinguish network errors from auth/db errors
  try {
    const fullUrl = buildDbUrl(baseUrl, dbName);
    const sql1 = postgres(fullUrl, opts);
    const [row] = await sql1`SELECT version() AS v`;
    await sql1.end();
    const version = (row?.v as string ?? '').split(' ').slice(0, 2).join(' ');
    steps.push({ label: 'Host reachable', ok: true, detail: version });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // If it's a network-level failure the host is unreachable; auth/db errors mean host IS up
    const hostUnreachable = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect timeout/i.test(msg);
    if (hostUnreachable) {
      steps.push({ label: 'Host reachable', ok: false, detail: msg });
      return res.json({ ok: false, steps });
    }
    // Host responded (auth error, db missing etc.) — host is reachable, continue to step 2
    steps.push({ label: 'Host reachable', ok: true, detail: 'Host up (proceeding to check database)' });
  }

  // Step 2: target database accessible
  const fullUrl = buildDbUrl(baseUrl, dbName);
  try {
    const sql2 = postgres(fullUrl, opts);
    await sql2`SELECT 1`;
    await sql2.end();
    steps.push({ label: `Database "${dbName || new URL(baseUrl).pathname.replace('/', '')}" accessible`, ok: true });
  } catch (e: unknown) {
    steps.push({ label: 'Database accessible', ok: false, detail: e instanceof Error ? e.message : String(e) });
    return res.json({ ok: false, steps });
  }

  // Step 3: schema ready — check both required tables exist
  try {
    const sql3 = postgres(fullUrl, opts);
    const rows = await sql3`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('kb_documents', 'approvals')
    `;
    await sql3.end();
    const found = rows.map((r: any) => r.table_name as string);
    const missing = ['kb_documents', 'approvals'].filter(t => !found.includes(t));
    if (missing.length > 0) {
      steps.push({ label: 'Schema ready', ok: false, detail: `Missing tables: ${missing.join(', ')} — run src/kb/schema.sql` });
      return res.json({ ok: false, steps });
    }
    steps.push({ label: 'Schema ready', ok: true, detail: 'kb_documents + approvals tables found' });
  } catch (e: unknown) {
    steps.push({ label: 'Schema ready', ok: false, detail: e instanceof Error ? e.message : String(e) });
    return res.json({ ok: false, steps });
  }

  res.json({ ok: true, steps });
});

// Jira
app.get('/api/jira/issues', async (req, res) => {
  try {
    if (config.mode === 'mock') {
      if (!mcpConnected) await connectMCP();
      const jql = (req.query.jql as string) || defaultJiraJql();
      const result = await mcpClients.jira!.callTool({ name: 'jira_search', arguments: { jql, max_results: 30 } });
      const text = (result.content as Array<{text:string}>)[0]?.text ?? '[]';
      return res.json(JSON.parse(text));
    }
    const jql = (req.query.jql as string) || defaultJiraJql();
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
  const { issueKey, jiraIssueId, issueSummary, projectKey, folder, requestedBy, testCases } = req.body;
  const id = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const approval = {
    id, issueKey, jiraIssueId, issueSummary: issueSummary || issueKey,
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

  if (config.mode === 'mock' && !mcpConnected) await connectMCP();

  const toUpload = apr.testCases.filter(t => t.approved);
  if (!toUpload.length) return res.status(400).json({ error: 'No approved test cases to upload' });

  const uploadedKeys: string[] = [];
  const failed: string[] = [];

  // Resolve Jira numeric issueId — needed by Zephyr POST /links/issues
  let resolvedJiraIssueId: string | undefined = (apr as any).jiraIssueId;
  if (!resolvedJiraIssueId && config.mode === 'live') {
    try {
      const jiraBase = config.jiraUrl.replace(/\/$/, '');
      const jr = await fetch(`${jiraBase}/rest/api/3/issue/${apr.issueKey}?fields=summary`, { headers: atlassianHeaders() });
      if (jr.ok) { const jd = await jr.json() as { id?: string }; resolvedJiraIssueId = jd.id; }
    } catch { /* use key as fallback */ }
    console.log(`  [Jira] resolved issueId for ${apr.issueKey}: ${resolvedJiraIssueId}`);
  }

  // 1. Upload each approved test to Zephyr
  for (const tc of toUpload) {
    try {
      const steps = tc.steps?.length > 0
        ? tc.steps
        : [{ description: 'Execute as described', expectedResult: tc.outcome || 'Test passes' }];
      const payload: Record<string, unknown> = {
        projectKey: apr.projectKey,
        name: tc.name,
        objective: tc.content.slice(0, 500),
        precondition: tc.precondition || 'See test case details',
        priority: mapZephyrPriority(tc.priority || 'High'),
        folder: apr.folder || 'Generated',
        labels: ['approved', 'test-agent', apr.issueKey.toLowerCase()],
        issueLinks: [apr.issueKey],
      };
      const created = config.mode === 'mock'
        ? JSON.parse(((await mcpClients.zephyr!.callTool({ name: 'zephyr_create_test_case', arguments: payload })).content as Array<{text:string}>)[0]?.text ?? '{}').created
        : await directZephyrCreate(payload);
      if (created?.key) {
        uploadedKeys.push(created.key);
        if (config.mode === 'live') {
          await directZephyrAddSteps(created.key, steps);
          await directZephyrSetIssueLink(created.key, resolvedJiraIssueId ?? apr.issueKey);
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
      priority: mapZephyrPriority(priority || 'High'),
      folder: folder || 'Generated',
      labels: labels || ['auto-generated'],
    };
    const created = await directZephyrCreate(payload);
    if (created?.key && steps && Array.isArray(steps) && steps.length > 0) {
      await directZephyrAddSteps(created.key, steps);
    }
    res.json({ created });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─── Generate (SSE stream) ────────────────────────────────────────────────────

app.post('/api/generate', async (req, res) => {
  const { issueKey, prompt: customPrompt, issueDetail: clientIssueDetail } = req.body as { issueKey?: string; prompt?: string; issueDetail?: JiraIssue };

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
      console.log(`  [Generate] issueContext for ${issueKey}: ${issueContext.length} chars — preview: ${issueContext.slice(0, 300).replace(/\n/g, '↵')}`);
    } catch (e) {
      console.log(`  Jira fetch skipped: ${e}`);
      // Fall back to the issue detail already loaded by the client
      if (clientIssueDetail) {
        issueContext = [
          `**Summary:** ${clientIssueDetail.summary}`,
          clientIssueDetail.description ? `**Description:**\n${clientIssueDetail.description}` : '',
          clientIssueDetail.priority ? `**Priority:** ${clientIssueDetail.priority.name}` : '',
          clientIssueDetail.status ? `**Status:** ${clientIssueDetail.status.name}` : '',
        ].filter(Boolean).join('\n');
        console.log(`  Jira fallback: using client-provided issueDetail for ${issueKey}`);
      }
    }

    try {
      const summary = issueContext.split('\n')[0].replace('**Summary:** ', '');
      confluenceContext = await directConfluenceSearch(summary || issueKey);
      if (confluenceContext) console.log(`  Confluence: found related pages`);
    } catch (e) { console.log(`  Confluence fetch skipped: ${e}`); }

    try {
      const existing = (await directZephyrTestCases(issueKey))
        .filter(t => t.status?.name?.toLowerCase() !== 'archived');
      if (existing.length > 0) {
        existingTestsContext = `Existing test cases (${existing.length}):\n` +
          existing.map(t => `- ${t.key}: ${t.name}`).join('\n');
        console.log(`  Zephyr: ${existing.length} existing tests found`);
      } else {
        console.log(`  Zephyr: no active tests found`);
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
        undefined,
        { mode: config.kbScopeMode ?? 'project', projects: config.kbScopeProjects }
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

  // Always prepend the server-fetched context block, regardless of whether
  // the client sent a custom prompt — the client never has the context.
  const instruction = customPrompt ??
    (issueKey
      ? `Generate comprehensive test cases for Jira issue ${issueKey}. ` +
        `Generate test cases covering all acceptance criteria, edge cases, and negative tests. ` +
        `Avoid duplicating any existing Zephyr tests or KB patterns listed above. ` +
        `Always number test cases starting from TC-001. ` +
        `Follow the structure in CLAUDE.md.`
      : 'Help me generate test cases.');

  const prompt = issueKey
    ? `IMPORTANT: Do NOT use any MCP tools, make any tool calls, or fetch any external data. ` +
      `Generate test cases directly from the context provided below.\n\n` +
      (contextBlock
        ? `${contextBlock}\n\n`
        : `No additional context retrieved — generate from issue key alone.\n\n`) +
      instruction
    : instruction;

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

  // Always seed local KB first (hardcoded demo data lives in seed.ts)
  const localKb = new LocalKnowledgeBase(path.join(ROOT, 'local-kb-data'));
  await localKb.clear();
  await new Promise<void>(resolve => {
    const child = spawn('npx', ['tsx', 'src/local-kb/seed.ts'], { cwd: ROOT, env: process.env });
    child.stdout.on('data', (d: Buffer) => send(d.toString().trim()));
    child.stderr.on('data', (d: Buffer) => send(d.toString().trim()));
    child.on('close', () => resolve());
  });

  // If backend is pgvector, migrate the freshly seeded local docs across
  if (db instanceof PgKnowledgeBase) {
    const apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      send('⚠ Skipping PG migration — ANTHROPIC_API_KEY not set (needed for voyage-3 embeddings)');
    } else {
      send('Migrating seed data to EC2 / pgvector…');
      const localDocs = await localKb.retrieve('', { topK: 99999, minScore: 0 });
      let migrated = 0;
      for (const doc of localDocs) {
        const id = (doc.metadata as any).id ?? `seeded:${migrated}`;
        const source = ((doc.metadata as any).source ?? 'generated') as 'jira' | 'zephyr' | 'confluence' | 'generated';
        try {
          await db.addDocument({ id, source, content: doc.content, metadata: doc.metadata as any });
          migrated++;
          send(`[${migrated}/${localDocs.length}] ✓ ${id}`);
        } catch (e: any) {
          send(`✗ ${id}: ${e.message}`);
        }
      }
      send(`Migrated ${migrated}/${localDocs.length} documents to pgvector ✓`);
    }
  }

  send('Seed complete ✓', true);
  res.end();
});

// ─── Zephyr → KB bulk import ─────────────────────────────────────────────────
// Streams SSE progress. Idempotent: existing zephyr:KEY entries are skipped.

app.post('/api/kb/import/zephyr', async (_req, res) => {
  const projectKey = config.jiraProjectKey;
  if (!projectKey) { res.status(400).json({ error: 'No Jira project key configured' }); return; }
  if (!config.zephyrApiToken) { res.status(400).json({ error: 'Zephyr API token not configured' }); return; }
  if (!config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
    res.status(400).json({ error: 'ANTHROPIC_API_KEY required to generate embeddings' }); return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (message: string, done = false) =>
    res.write(`data: ${JSON.stringify({ message, done })}\n\n`);

  try {
    send(`Fetching all Zephyr test cases for project ${projectKey}…`);
    const testCases = await directZephyrAllTestCases(projectKey);
    send(`Found ${testCases.length} test case(s) in Zephyr`);

    // Idempotency: collect IDs already in KB so we skip them
    const existingIds = new Set(await db.listIds());
    const toImport = testCases.filter(tc => !existingIds.has(`zephyr:${tc.key}`));
    const skippedCount = testCases.length - toImport.length;

    if (skippedCount > 0) send(`Skipping ${skippedCount} already-imported test case(s)`);
    if (toImport.length === 0) {
      send('Nothing new to import — all Zephyr test cases are already in the KB', true);
      res.end(); return;
    }

    send(`Importing ${toImport.length} new test case(s)…`);

    let imported = 0, errors = 0;
    for (const tc of toImport) {
      try {
        const doc = formatZephyrDocument(tc);
        await db.addDocument(doc);
        imported++;
        if (imported % 10 === 0 || imported === toImport.length) {
          send(`Progress: ${imported} / ${toImport.length}`);
        }
      } catch (e: any) {
        errors++;
        console.warn(`[KB import] failed for ${tc.key}:`, e);
        send(`✗ ${tc.key}: ${e.message ?? String(e)}`);
      }
    }

    send(
      `✓ Import complete — ${imported} imported, ${skippedCount} skipped${errors ? `, ${errors} error(s)` : ''}`,
      true,
    );
  } catch (e: any) {
    send(`Error: ${e.message ?? String(e)}`, true);
  }
  res.end();
});

app.delete('/api/kb/clear', async (_req, res) => {
  await db.clear(); res.json({ ok: true });
});

// Returns distinct project keys present in the KB — used to populate the scope selector
app.get('/api/kb/projects', async (_req, res) => {
  try {
    let projects: string[] = [];
    if (db instanceof PgKnowledgeBase) {
      const rows: Array<{ pk: string }> = await (db as any).sql`
        SELECT DISTINCT metadata->>'project_key' AS pk
        FROM   kb_documents
        WHERE  metadata->>'project_key' IS NOT NULL
          AND  metadata->>'project_key' != ''
        ORDER  BY pk
      `;
      projects = rows.map(r => r.pk);
    } else {
      // Local KB: extract from document IDs (format: source:PROJ-NNN:...)
      const ids = await db.listIds();
      const seen = new Set<string>();
      for (const id of ids) {
        const parts = id.split(':');
        if (parts.length >= 2) {
          const proj = parts[1].split('-')[0];
          if (proj) seen.add(proj);
        }
      }
      projects = [...seen].sort();
    }
    res.json({ projects });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
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

  if (config.mode === 'mock') connectMCP().catch(e => console.error('MCP connect error:', e));
});
