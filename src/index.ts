/**
 * atlassian-test-agent — src/index.ts (KB-integrated version)
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getAllMCPTools } from './mcp-utils.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { validateEnv } from './config.js';
import { logger } from './logger.js';
import {
  isKBConfigured, loadKBConfig, retrieveContextForIssue, promptForApproval,
} from './knowledge-base/index.js';
import { MCPClients } from './types.js';

const env = validateEnv();
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const CLAUDE_MD_PATH = path.resolve(process.cwd(), 'CLAUDE.md');
const baseSystemPrompt = fs.existsSync(CLAUDE_MD_PATH)
  ? fs.readFileSync(CLAUDE_MD_PATH, 'utf-8')
  : 'You are a QA engineer. Generate test cases from Jira, Confluence and Zephyr.';
const kbEnabled = isKBConfigured();
if (kbEnabled) logger.info('KB configured — context retrieval enabled');

function extractIssueKey(text: string): string | undefined {
  return text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1];
}

async function createAtlassianClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'uvx', args: ['mcp-atlassian'],
    env: { ...process.env, JIRA_URL: env.JIRA_URL, JIRA_USERNAME: env.JIRA_USERNAME,
      JIRA_API_TOKEN: env.JIRA_API_TOKEN, CONFLUENCE_URL: env.CONFLUENCE_URL,
      CONFLUENCE_USERNAME: env.CONFLUENCE_USERNAME, CONFLUENCE_API_TOKEN: env.CONFLUENCE_API_TOKEN },
  });
  const client = new Client({ name: 'atlassian-test-agent', version: '1.0.0' });
  await client.connect(transport);
  logger.info('mcp-atlassian connected');
  return client;
}

async function createZephyrClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx', args: ['-y', '@smartbear/mcp@latest'],
    env: { ...process.env, ZEPHYR_API_TOKEN: env.ZEPHYR_API_TOKEN, ZEPHYR_BASE_URL: env.ZEPHYR_BASE_URL },
  });
  const client = new Client({ name: 'atlassian-test-agent-zephyr', version: '1.0.0' });
  await client.connect(transport);
  logger.info('smartbear-mcp connected');
  return client;
}

async function buildSystemPrompt(userMessage: string): Promise<string> {
  if (!kbEnabled) return baseSystemPrompt;
  const issueKey = extractIssueKey(userMessage);
  if (!issueKey) return baseSystemPrompt;
  try {
    const kbConfig = loadKBConfig();
    const kbContext = await retrieveContextForIssue(issueKey, issueKey.split('-')[0], undefined, kbConfig);
    return kbContext ? `${baseSystemPrompt}\n\n---\n\n${kbContext}` : baseSystemPrompt;
  } catch { return baseSystemPrompt; }
}

async function runAgent(clients: MCPClients, userMessage: string, history: Anthropic.MessageParam[] = []): Promise<string> {
  const tools = await getAllMCPTools(clients.atlassian, clients.zephyr);
  const systemPrompt = await buildSystemPrompt(userMessage);
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userMessage }];

  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 8096,
      system: systemPrompt, messages, tools,
    });

    if (response.stop_reason === 'end_turn') {
      return response.content.find(b => b.type === 'text')?.text ?? '';
    }
    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        logger.info(`Calling tool: ${block.name}`);
        try {
          const mcpClient = block.name.startsWith('zephyr_') ? clients.zephyr : clients.atlassian;
          const result = await mcpClient.callTool({ name: block.name, arguments: block.input as Record<string, unknown> });
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result.content) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
  }
  return '(Max iterations reached)';
}

async function runInteractive(clients: MCPClients): Promise<void> {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const approver = process.env.USER ?? 'user';

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Atlassian Test Agent — powered by Claude');
  console.log(`  Jira · Confluence · Zephyr · KB(${kbEnabled ? 'on' : 'off'})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const ask = () => rl.question('You: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.toLowerCase() === 'exit') { rl.close(); return; }
    try {
      console.log('\nThinking...\n');
      const response = await runAgent(clients, trimmed, history);
      history.push({ role: 'user', content: trimmed }, { role: 'assistant', content: response });
      if (history.length > 20) history.splice(0, 2);
      console.log('─'.repeat(60) + '\n' + response + '\n' + '─'.repeat(60) + '\n');
      const issueKey = extractIssueKey(trimmed);
      if (issueKey && kbEnabled && /generate|create|write|produce/i.test(trimmed)) {
        await promptForApproval(response, issueKey, loadKBConfig(), approver);
      }
    } catch (err) { console.error(`Error: ${err}`); }
    ask();
  });
  ask();
}

async function runGenerate(clients: MCPClients, issueKey: string): Promise<void> {
  const prompt = `Generate comprehensive test cases for Jira issue ${issueKey}. Fetch the ticket, check Confluence, retrieve Zephyr test cases, then generate new ones covering all acceptance criteria including edge cases and negative tests.`;
  const response = await runAgent(clients, prompt);
  console.log(response);
  const outputPath = path.resolve(process.cwd(), `test-cases-${issueKey}.md`);
  fs.writeFileSync(outputPath, response, 'utf-8');
  console.log(`\nSaved to ${outputPath}`);
  if (kbEnabled) await promptForApproval(response, issueKey, loadKBConfig(), process.env.USER ?? 'cli');
}

async function main(): Promise<void> {
  let ac: Client | undefined, zc: Client | undefined;
  try {
    [ac, zc] = await Promise.all([createAtlassianClient(), createZephyrClient()]);
    const clients: MCPClients = { atlassian: ac, zephyr: zc };
    const [mode, arg] = process.argv.slice(2);
    if (mode === 'generate' && arg) await runGenerate(clients, arg);
    else await runInteractive(clients);
  } catch (err) { logger.error(`Fatal: ${err}`); process.exit(1); }
  finally { await ac?.close().catch(() => {}); await zc?.close().catch(() => {}); }
}
main();
