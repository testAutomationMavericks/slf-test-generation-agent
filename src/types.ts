/**
 * src/types.ts — Shared type definitions
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface MCPClients {
  atlassian: Client;
  zephyr: Client;
}

export interface TestCase {
  id: string;
  title: string;
  type: 'Functional' | 'Regression' | 'Edge Case' | 'Negative' | 'Performance' | 'Security';
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  labels: string[];
  preconditions: string[];
  steps: TestStep[];
  expectedOutcome: string;
  notes?: string;
  jiraIssueKey?: string;
}

export interface TestStep {
  step: number;
  action: string;
  expectedResult: string;
}

export interface GenerationResult {
  issueKey: string;
  issueTitle: string;
  testCases: TestCase[];
  coverageMap: Record<string, string[]>; // AC → test case IDs
  gaps: string[];
  summary: string;
}

export interface ZephyrTestCase {
  key?: string;
  name: string;
  objective?: string;
  precondition?: string;
  labels?: string[];
  priority?: { name: string };
  folder?: { id: number };
  testScript?: {
    type: 'STEP_BY_STEP' | 'PLAIN_TEXT' | 'BDD';
    steps?: Array<{ description: string; expectedResult: string }>;
    text?: string;
  };
}
