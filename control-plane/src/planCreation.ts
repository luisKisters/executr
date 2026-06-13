import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_CONTROL_PLANE_PROVIDER, type ProviderName } from './contracts';
import { claimPlan } from './claims';


export type PlanProvider = ProviderName | 'auto';

export interface PlanInput {
  title: string;
  body: string;
  validationCommands: string;
  provider: PlanProvider;
}

export type CreatePlanOutcome =
  | { ok: true; planName: string; fileName: string; planHash: string }
  | { ok: false; error: string; statusCode: number };

// Convert a title to a safe filename slug.
export function titleToFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

// Compute SHA-256 hash of a string.
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// Returns an error message if the input is invalid, otherwise null.
export function validatePlanInput(input: PlanInput): string | null {
  const { title, body, validationCommands } = input;

  if (!title.trim()) return 'Title is required';

  const slug = titleToFilename(title);
  if (!slug) return 'Title must contain at least one alphanumeric character';

  if (!validationCommands.trim()) return 'Validation commands are required';

  if (!body.trim()) return 'Body is required';

  // Reject * [ ] bullets
  if (/^\s*\* \[[ x]\]/m.test(body)) {
    return 'Body uses `* [ ]` bullets; use `- [ ]` instead (ralphex format requires dashes)';
  }

  // Must have at least one ### Task / Iteration heading
  const taskMatch = /^###\s+(?:Task|Iteration)\s+(\d+)\s*:/m.exec(body);
  if (!taskMatch) {
    return 'Body must contain at least one task section (e.g. `### Task 1: My task`)';
  }

  // Reject Task 0
  if (parseInt(taskMatch[1], 10) === 0) {
    return 'Tasks must be numbered from 1, not 0 (ralphex format requirement)';
  }

  return null;
}

// Generate the full ralphex-format markdown from validated inputs.
export function generatePlanMarkdown(input: PlanInput): string {
  return `# Plan: ${input.title.trim()}\n\n## Validation Commands\n\n\`\`\`\n${input.validationCommands.trim()}\n\`\`\`\n\n${input.body.trim()}\n`;
}

export function isSafeSegment(segment: string): boolean {
  return !/[/\\]/.test(segment) && segment !== '..' && segment !== '.';
}

export interface CreatePlanOptions {
  workspaceRoot: string;
  claimsDir: string;
  repo: string;
  input: PlanInput;
}

export function createPlan(opts: CreatePlanOptions): CreatePlanOutcome {
  const { workspaceRoot, claimsDir, repo, input } = opts;

  if (!isSafeSegment(repo)) {
    return { ok: false, error: 'Invalid repo name', statusCode: 400 };
  }

  const safeRoot = resolve(workspaceRoot);
  const repoPath = resolve(join(workspaceRoot, repo));
  if (!repoPath.startsWith(safeRoot + '/') && repoPath !== safeRoot) {
    return { ok: false, error: 'Invalid repo name', statusCode: 400 };
  }

  const validationError = validatePlanInput(input);
  if (validationError) {
    return { ok: false, error: validationError, statusCode: 400 };
  }

  const planName = titleToFilename(input.title);
  const plansDir = join(repoPath, 'docs', 'plans');
  const planFileName = `${planName}.md`;
  const planFilePath = join(plansDir, planFileName);

  // Guard against title-based traversal after slugification
  const safePlansDir = resolve(plansDir);
  if (!resolve(planFilePath).startsWith(safePlansDir + '/')) {
    return { ok: false, error: 'Invalid plan title', statusCode: 400 };
  }

  const markdown = generatePlanMarkdown(input);
  const planHash = hashContent(markdown);

  mkdirSync(plansDir, { recursive: true });

  const tmpPath = join(plansDir, `${planName}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpPath, markdown, 'utf8');
    renameSync(tmpPath, planFilePath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    return { ok: false, error: `Failed to write plan file: ${String(err)}`, statusCode: 500 };
  }

  // Write a claim for non-claude-code, non-auto providers
  if (input.provider === 'codex') {
    claimPlan(claimsDir, repo, planHash, 'codex');
  }

  return { ok: true, planName, fileName: planFileName, planHash };
}

export interface SubmitRawPlanOptions {
  workspaceRoot: string;
  claimsDir: string;
  repo: string;
  markdown: string;
  provider?: PlanProvider;
}

// Write a pre-generated ralphex markdown plan directly (used by Telegram /submit).
export function submitRawPlan(opts: SubmitRawPlanOptions): CreatePlanOutcome {
  const { workspaceRoot, claimsDir, repo, markdown, provider = DEFAULT_CONTROL_PLANE_PROVIDER } = opts;

  if (!isSafeSegment(repo)) {
    return { ok: false, error: 'Invalid repo name', statusCode: 400 };
  }

  const safeRoot = resolve(workspaceRoot);
  const repoPath = resolve(join(workspaceRoot, repo));
  if (!repoPath.startsWith(safeRoot + '/') && repoPath !== safeRoot) {
    return { ok: false, error: 'Invalid repo name', statusCode: 400 };
  }

  const titleMatch = /^#\s+Plan:\s+(.+)$/m.exec(markdown);
  if (!titleMatch) {
    return { ok: false, error: 'Draft plan must start with "# Plan: <title>"', statusCode: 400 };
  }
  const title = titleMatch[1].trim();
  if (!title) {
    return { ok: false, error: 'Plan title cannot be empty', statusCode: 400 };
  }

  if (!/^##\s+Validation Commands/m.test(markdown)) {
    return { ok: false, error: 'Draft plan missing ## Validation Commands section', statusCode: 400 };
  }
  if (!/^###\s+(?:Task|Iteration)\s+[1-9]/m.test(markdown)) {
    return { ok: false, error: 'Draft plan must contain ### Task N: sections numbered from 1', statusCode: 400 };
  }
  if (/^\s*\* \[[ x]\]/m.test(markdown)) {
    return { ok: false, error: 'Draft plan uses * [ ] bullets; use - [ ] instead', statusCode: 400 };
  }

  const planName = titleToFilename(title);
  if (!planName) {
    return { ok: false, error: 'Invalid plan title', statusCode: 400 };
  }

  const plansDir = join(repoPath, 'docs', 'plans');
  const planFileName = `${planName}.md`;
  const planFilePath = join(plansDir, planFileName);

  const safePlansDir = resolve(plansDir);
  if (!resolve(planFilePath).startsWith(safePlansDir + '/')) {
    return { ok: false, error: 'Invalid plan title', statusCode: 400 };
  }

  const planHash = hashContent(markdown);
  mkdirSync(plansDir, { recursive: true });

  const tmpPath = join(plansDir, `${planName}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpPath, markdown, 'utf8');
    renameSync(tmpPath, planFilePath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    return { ok: false, error: `Failed to write plan file: ${String(err)}`, statusCode: 500 };
  }

  if (provider === 'codex') {
    claimPlan(claimsDir, repo, planHash, 'codex');
  }

  return { ok: true, planName, fileName: planFileName, planHash };
}
