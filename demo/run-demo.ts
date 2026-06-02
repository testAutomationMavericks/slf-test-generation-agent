/**
 * demo/run-demo.ts
 *
 * Full end-to-end demo using:
 *   - Mock Jira MCP server (no Atlassian account needed)
 *   - Mock Confluence MCP server
 *   - Mock Zephyr MCP server
 *   - Local file-based vector DB (no AWS needed)
 *   - Real Claude API (requires ANTHROPIC_API_KEY)
 *
 * Usage:
 *   npm run demo                   — run all demo scenarios
 *   npm run demo -- --ticket DEMO-3  — run for specific ticket
 *   npm run demo -- --interactive   — interactive REPL with mocks
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getAllMCPTools } from '../src/mcp-utils.js';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { LocalKnowledgeBase, retrieveLocalContextForIssue } from '../src/local-kb/local-vector-db.js';
import { formatTestCaseDocument } from '../src/knowledge-base/bedrock-kb.js';
import { logger } from '../src/logger.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = new LocalKnowledgeBase('./local-kb-data');

const CLAUDE_MD = path.resolve(process.cwd(), 'CLAUDE.md');
const basePrompt = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf-8')
  : 'You are an expert QA engineer. Generate comprehensive test cases.';

// ─── Mock MCP Clients ─────────────────────────────────────────────────────────

async function startMockServer(name: string, serverFile: string): Promise<Client> {
  const serverPath = path.resolve(process.cwd(), serverFile);
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
    env: { ...process.env },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  process.stderr.write(`[demo] ${name} connected\n`);
  return client;
}

interface DemoClients {
  jira: Client;
  confluence: Client;
  zephyr: Client;
}

async function startAllMocks(): Promise<DemoClients> {
  console.log('Starting mock MCP servers...');
  const [jira, confluence, zephyr] = await Promise.all([
    startMockServer('mock-jira',       'src/mocks/jira-server.ts'),
    startMockServer('mock-confluence', 'src/mocks/confluence-server.ts'),
    startMockServer('mock-zephyr',     'src/mocks/zephyr-server.ts'),
  ]);
  console.log('✓ All mock servers running\n');
  return { jira, confluence, zephyr };
}

// ─── Agent ────────────────────────────────────────────────────────────────────

async function runAgent(
  clients: DemoClients,
  userMessage: string,
  issueKey?: string
): Promise<string> {
  // Gather tools from all three mock servers
  const tools = await getAllMCPTools(clients.jira, clients.confluence, clients.zephyr);

  // Inject local KB context if an issue key was detected
  let systemPrompt = basePrompt;
  if (issueKey) {
    try {
      const kbContext = await retrieveLocalContextForIssue(
        db, issueKey, issueKey.split('-')[0]
      );
      if (kbContext) {
        systemPrompt = `${basePrompt}\n\n---\n\n${kbContext}`;
        console.log(`  [KB] Injected ${kbContext.split('\n').length} lines of context\n`);
      }
    } catch (e) {
      // KB might not be seeded yet — continue without it
    }
  }

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      system: systemPrompt,
      messages,
      tools,
    });

    if (response.stop_reason === 'end_turn') {
      return response.content.find((b) => b.type === 'text')?.text ?? '';
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        console.log(`  → ${block.name}(${JSON.stringify(block.input).slice(0, 60)}...)`);

        // Route to correct mock client
        let mcpClient: Client;
        if (block.name.startsWith('jira_')) mcpClient = clients.jira;
        else if (block.name.startsWith('confluence_')) mcpClient = clients.confluence;
        else mcpClient = clients.zephyr;

        try {
          const result = await mcpClient.callTool({
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
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

// ─── KB Write-Back (local) ────────────────────────────────────────────────────

async function saveToLocalKB(
  content: string,
  issueKey: string,
  approvedBy: string
): Promise<void> {
  const doc = formatTestCaseDocument(content, {
    jiraIssueKey: issueKey,
    approvedBy,
    projectKey: issueKey.split('-')[0],
  });
  await db.addDocument(doc);
  const count = await db.count();
  console.log(`\n✓ Saved to local KB. Total documents: ${count}`);
}

// ─── Demo Scenarios ───────────────────────────────────────────────────────────

async function runScenario(
  clients: DemoClients,
  title: string,
  prompt: string,
  issueKey?: string,
  saveToKB = false
): Promise<string> {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`SCENARIO: ${title}`);
  console.log('═'.repeat(65));
  console.log(`Prompt: "${prompt}"\n`);
  console.log('Calling tools...');

  const result = await runAgent(clients, prompt, issueKey);

  console.log('\n' + '─'.repeat(65));
  console.log(result);
  console.log('─'.repeat(65));

  // Save output
  const filename = `demo-output-${issueKey ?? title.toLowerCase().replace(/\s+/g, '-')}.md`;
  fs.writeFileSync(filename, result, 'utf-8');
  console.log(`\n✓ Output saved to ${filename}`);

  if (saveToKB && issueKey) {
    await saveToLocalKB(result, issueKey, 'demo-user');
  }

  return result;
}

async function runInteractiveDemo(clients: DemoClients): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n' + '━'.repeat(65));
  console.log('  Interactive Demo — Mock Jira · Confluence · Zephyr + Local KB');
  console.log('━'.repeat(65));
  console.log('Available tickets: DEMO-1 (login), DEMO-2 (basket), DEMO-3 (discount), DEMO-4 (password reset)');
  console.log('\nTry:');
  console.log('  Generate test cases for DEMO-3');
  console.log('  What test coverage exists for DEMO-1?');
  console.log('  Find gaps in test coverage for the basket epic DEMO-11');
  console.log('  Type "exit" to quit\n');

  const ask = () => rl.question('You: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.toLowerCase() === 'exit') { rl.close(); return; }

    const issueKey = trimmed.match(/\b(DEMO-\d+)\b/i)?.[1]?.toUpperCase();

    try {
      console.log('\nThinking...\n');
      const result = await runAgent(clients, trimmed, issueKey);
      console.log('\n' + '─'.repeat(65));
      console.log(result);
      console.log('─'.repeat(65) + '\n');

      // Offer KB save on generation requests
      if (issueKey && /generate|create|write/i.test(trimmed)) {
        rl.question('\nSave to local KB? (y/n): ', async (ans) => {
          if (ans.trim().toLowerCase() === 'y') {
            await saveToLocalKB(result, issueKey, 'demo-user');
          }
          ask();
        });
        return;
      }
    } catch (err) {
      console.error(`Error: ${err}`);
    }
    ask();
  });

  ask();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isInteractive = args.includes('--interactive');
  const ticketArg = args.includes('--ticket') ? args[args.indexOf('--ticket') + 1] : null;

  // Verify local KB is seeded
  const count = await db.count().catch(() => 0);
  if (count === 0) {
    console.log('Local KB is empty. Run: npm run kb:local:seed\n');
    console.log('Continuing without KB context...\n');
  } else {
    console.log(`Local KB ready: ${count} documents\n`);
  }

  const clients = await startAllMocks();

  try {
    if (isInteractive) {
      await runInteractiveDemo(clients);
      return;
    }

    if (ticketArg) {
      await runScenario(
        clients,
        `Generate for ${ticketArg.toUpperCase()}`,
        `Generate comprehensive test cases for Jira issue ${ticketArg.toUpperCase()}`,
        ticketArg.toUpperCase(),
        true
      );
      return;
    }

    // Default: run a sequence of showcase scenarios
    await runScenario(
      clients,
      'Gap Analysis — Discount Code (DEMO-3, no existing tests)',
      'Generate test cases for DEMO-3. Check existing Zephyr coverage first and identify any gaps.',
      'DEMO-3',
      true
    );

    await runScenario(
      clients,
      'Coverage Report — Login (DEMO-1, 3 existing tests)',
      'What test coverage do we have for DEMO-1? List existing tests, identify gaps, then generate missing cases.',
      'DEMO-1',
      false
    );

    await runScenario(
      clients,
      'Architecture-Informed Tests — Password Reset (DEMO-4)',
      'Generate test cases for DEMO-4. Read the Confluence auth architecture page first and use it to inform security and edge case tests.',
      'DEMO-4',
      true
    );

    // Demonstrate KB retrieval compounding
    const kbCount = await db.count();
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`DEMO COMPLETE`);
    console.log(`Local KB now contains ${kbCount} documents`);
    console.log(`Future queries will retrieve this context automatically.`);
    console.log(`\nSwap to real servers by updating .mcp.json — see README.md`);
    console.log('═'.repeat(65) + '\n');

  } finally {
    await clients.jira.close().catch(() => {});
    await clients.confluence.close().catch(() => {});
    await clients.zephyr.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Demo failed:', err.message ?? err);
  process.exit(1);
});
