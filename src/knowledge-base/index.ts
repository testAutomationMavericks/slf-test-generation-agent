/**
 * src/knowledge-base/index.ts
 *
 * Barrel export + KB config loader from environment variables.
 */

import { z } from 'zod';
import { KBWriteBackConfig } from './types.js';

export * from './bedrock-kb.js';
export * from './bedrock-retrieval.js';
export * from './approval-pipeline.js';
export * from './types.js';

// ─── Config from Environment ──────────────────────────────────────────────────

const kbEnvSchema = z.object({
  AWS_REGION: z.string().default('us-east-1'),
  KB_S3_BUCKET: z.string().min(1, 'KB_S3_BUCKET is required for Knowledge Base features'),
  KB_S3_PREFIX: z.string().default('kb-docs'),
  KB_KNOWLEDGE_BASE_ID: z.string().min(1, 'KB_KNOWLEDGE_BASE_ID is required'),
  KB_DATA_SOURCE_ID: z.string().min(1, 'KB_DATA_SOURCE_ID is required'),
  AWS_PROFILE: z.string().optional(),
});

/**
 * Load KB config from environment variables.
 * Throws a clear error if required variables are missing.
 */
export function loadKBConfig(): KBWriteBackConfig {
  const result = kbEnvSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Missing Knowledge Base environment variables:\n${missing}\n\n` +
        `Add these to your .env file. See .env.example for details.`
    );
  }

  return {
    awsRegion: result.data.AWS_REGION,
    s3Bucket: result.data.KB_S3_BUCKET,
    s3Prefix: result.data.KB_S3_PREFIX,
    knowledgeBaseId: result.data.KB_KNOWLEDGE_BASE_ID,
    dataSourceId: result.data.KB_DATA_SOURCE_ID,
    awsProfile: result.data.AWS_PROFILE,
  };
}

/**
 * Returns true if all KB environment variables are configured.
 * Use this to gracefully degrade when KB is not set up yet.
 */
export function isKBConfigured(): boolean {
  return !!(
    process.env.KB_S3_BUCKET &&
    process.env.KB_KNOWLEDGE_BASE_ID &&
    process.env.KB_DATA_SOURCE_ID
  );
}
