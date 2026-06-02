/**
 * src/config.ts — Environment validation with clear error messages
 */

import { z } from 'zod';

const envSchema = z.object({
  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Jira
  JIRA_URL: z.string().url('JIRA_URL must be a valid URL'),
  JIRA_USERNAME: z.string().email('JIRA_USERNAME must be a valid email'),
  JIRA_API_TOKEN: z.string().min(1, 'JIRA_API_TOKEN is required'),

  // Confluence (shares same credentials on Atlassian Cloud)
  CONFLUENCE_URL: z.string().url('CONFLUENCE_URL must be a valid URL'),
  CONFLUENCE_USERNAME: z.string().email('CONFLUENCE_USERNAME must be a valid email'),
  CONFLUENCE_API_TOKEN: z.string().min(1, 'CONFLUENCE_API_TOKEN is required'),

  // Zephyr Scale
  ZEPHYR_API_TOKEN: z.string().min(1, 'ZEPHYR_API_TOKEN is required'),
  ZEPHYR_BASE_URL: z
    .string()
    .url()
    .default('https://api.zephyrscale.smartbear.com/v2'),

  // Agent config
  DEFAULT_JIRA_PROJECT: z.string().optional(),
  AUTO_WRITE_TO_ZEPHYR: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('\n❌ Missing or invalid environment variables:\n');
    result.error.issues.forEach((issue) => {
      console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
    });
    console.error('\nCopy .env.example to .env and fill in your credentials.\n');
    process.exit(1);
  }

  return result.data;
}
