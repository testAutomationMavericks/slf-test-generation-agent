/**
 * src/mcp-utils.ts
 *
 * Converts MCP tool definitions into Anthropic SDK tool format.
 * This replaces the `mcpTools` helper from @anthropic-ai/sdk/helpers/beta/mcp
 * which is not available in all SDK versions.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Fetch tools from an MCP client and convert them to the format
 * expected by the Anthropic messages API.
 */
export async function getMCPTools(client: Client): Promise<Anthropic.Tool[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Anthropic.Tool['input_schema'],
  }));
}

/**
 * Fetch and merge tools from multiple MCP clients.
 */
export async function getAllMCPTools(...clients: Client[]): Promise<Anthropic.Tool[]> {
  const results = await Promise.all(clients.map(getMCPTools));
  return results.flat();
}
