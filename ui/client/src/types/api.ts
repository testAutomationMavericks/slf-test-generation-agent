// ui/client/src/types/api.ts
// Shared types between React client and Express server

export type AIProvider = 'claudecode' | 'anthropic' | 'openai' | 'local'
export type ApprovalStatus = 'pending' | 'approved' | 'partial' | 'rejected' | 'uploaded'

export interface UIConfig {
  aiProvider: AIProvider
  jiraUrl: string
  jiraBearerToken: string
  jiraUsername: string
  jiraApiToken: string
  confluenceUrl: string
  confluenceSpaceKey: string
  confluenceUsername: string
  confluenceApiToken: string
  jiraProjectKey: string
  jiraEpicKey: string
  zephyrApiToken: string
  zephyrBaseUrl: string
  anthropicApiKey: string
  claudeModel: string
  openaiApiKey: string
  openaiModel: string
  localBaseUrl: string
  localModel: string
  localApiKey: string
  autoSaveToKB: boolean
  databaseUrl: string
  dbName: string
  kbScopeMode: 'project' | 'multi' | 'all'
  kbScopeProjects: string[]
}

export interface JiraIssue {
  id?: string
  key: string
  summary: string
  description?: string
  priority?: { name: string }
  status?: { name: string }
  labels?: string[]
  components?: Array<{ name: string }>
  epic?: { key: string; summary: string }
  assignee?: { displayName: string } | null
}

export interface ZephyrTestCase {
  key: string
  name: string
  objective?: string
  precondition?: string
  priority?: { name: string }
  status?: { name: string }
  folder?: { name: string }
  labels?: string[]
  steps?: Array<{ description: string; expectedResult: string }>
  linkedIssues?: string[]
  _new?: boolean
  issueKey?: string
}

export interface KBStats {
  total: number
  lastUpdated?: string
  backend?: 'pgvector'
  connectionUrl?: string
}

export interface ServerStatus {
  kbBackend: 'pgvector'
  aiProvider: AIProvider
  model: string
  claudeCode: { available: boolean; version?: string; error?: string }
  kb: KBStats
}

export interface ApprovalTestCase {
  id: number
  name: string
  type: string
  priority: string
  precondition: string
  steps: Array<{ description: string; expectedResult: string }>
  content: string
  outcome: string
  approved?: boolean
  rejected?: boolean
  approverComment?: string
}

export interface ApprovalRequest {
  id: string
  issueKey: string
  jiraIssueId?: string
  issueSummary: string
  projectKey: string
  folder: string
  requestedBy: string
  requestedAt: string
  testCases: ApprovalTestCase[]
  status: ApprovalStatus
  approvedBy?: string
  approvedAt?: string
  uploadedAt?: string
  zephyrKeys?: string[]
}

export interface ReviewCase {
  id: number
  name: string
  type: string
  priority: string
  precondition: string
  steps: Array<{ description: string; expectedResult: string }>
  content: string
  outcome: string
  selected: boolean
  uploaded: boolean
  uploadedKey?: string
  uploadError?: string | null
  kbSaved?: boolean
}

export interface GenerateEvent {
  type: 'mode' | 'chunk' | 'done' | 'error' | 'kb_context' | 'kb_saved'
  text?: string
  engine?: string
  message?: string
  count?: number
  fullOutput?: string
}
