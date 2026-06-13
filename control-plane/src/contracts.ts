export type ClassificationSignal =
  | 'healthy'
  | 'long_running_but_active'
  | 'known_startup_stall'
  | 'rate_limited'
  | 'waiting_for_human'
  | 'failed_finalize'
  | 'dirty_tree_blocked'
  | 'auth_missing'
  | 'tool_missing'
  | 'dead_loop';

export type AttemptStatus = 'completed' | 'failed' | 'needs_review' | 'aborted';
export type ProviderName = 'claude-code' | 'codex';
export type ValidationStatus = 'passed' | 'failed' | 'skipped';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export const DEFAULT_CONTROL_PLANE_PROVIDER: ProviderName = 'codex';
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CODEX_REASONING_EFFORT = 'xhigh';

export interface AttemptResult {
  status: AttemptStatus;
  provider: ProviderName;
  model: string;
  branch: string;
  tasksCompleted: number;
  commits: string[];
  validation: {
    status: ValidationStatus;
    logRef?: string;
  };
  classification: ClassificationSignal;
  summary: string;
  startedAt: string;
  endedAt: string;
}

export interface ProviderStatus {
  available: boolean;
  reason?: string;
}

export interface ApprovalRequest {
  id: string;
  repo: string;
  plan: string;
  action: string;
  context: string;
  status: ApprovalStatus;
  channel: string;
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
}
