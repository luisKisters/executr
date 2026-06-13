import { randomUUID } from 'node:crypto';
import type { OrchestratorDB, ApprovalRequestRow, TelegramSessionRow } from './db';
import {
  insertTelegramSession,
  getTelegramSessionsForUser,
  getCurrentSessionForUser,
  updateTelegramSession,
  setCurrentSession,
  listApprovalRequests,
  updateApprovalRequestStatus,
  upsertKnownUser,
  getKnownUserChatIds,
} from './db';
import type { AgentRunner, PlanningSession } from './providers';
import { submitRawPlan } from './planCreation';

// ── Minimal Telegram API types ─────────────────────────────────────────

interface TgFrom {
  id: number;
  first_name: string;
  username?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgFrom;
  chat: { id: number };
  text?: string;
  date: number;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// ── Injectable function types ──────────────────────────────────────────

export type SendMessageFn = (chatId: number, text: string) => Promise<void>;
export type GetUpdatesFn = (offset: number, timeout?: number) => Promise<TgUpdate[]>;

// ── Config ─────────────────────────────────────────────────────────────

export interface TelegramBotConfig {
  botToken: string;
  allowlist: number[];
}

// ── Command parsing ─────────────────────────────────────────────────────

export function parseCommandText(text: string): { command: string; rest: string } | null {
  const m = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { command: m[1].toLowerCase(), rest: (m[2] ?? '').trim() };
}

// ── Default API implementations ────────────────────────────────────────

function makeDefaultSendMessage(token: string): SendMessageFn {
  return async (chatId: number, text: string): Promise<void> => {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch {
      // best-effort; don't crash on Telegram API failures
    }
  };
}

function makeDefaultGetUpdates(token: string): GetUpdatesFn {
  return async (offset: number, timeout = 30): Promise<TgUpdate[]> => {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%5D`;
    try {
      const res = await fetch(url);
      const data = await res.json() as { ok: boolean; result?: TgUpdate[] };
      return data.ok && data.result ? data.result : [];
    } catch {
      return [];
    }
  };
}

// ── TelegramBot ─────────────────────────────────────────────────────────

export class TelegramBot {
  private readonly config: TelegramBotConfig;
  private readonly db: OrchestratorDB;
  private readonly workspaceRoot: string;
  private readonly claimsDir: string;
  private readonly runner: AgentRunner | null;
  private readonly sendMessageFn: SendMessageFn;
  private readonly getUpdatesFn: GetUpdatesFn;
  private running = false;
  private offset = 0;

  constructor(opts: {
    config: TelegramBotConfig;
    db: OrchestratorDB;
    workspaceRoot: string;
    claimsDir: string;
    runner?: AgentRunner;
    sendMessage?: SendMessageFn;
    getUpdates?: GetUpdatesFn;
  }) {
    this.config = opts.config;
    this.db = opts.db;
    this.workspaceRoot = opts.workspaceRoot;
    this.claimsDir = opts.claimsDir;
    this.runner = opts.runner ?? null;
    this.sendMessageFn = opts.sendMessage ?? makeDefaultSendMessage(opts.config.botToken);
    this.getUpdatesFn = opts.getUpdates ?? makeDefaultGetUpdates(opts.config.botToken);
  }

  isAllowed(userId: number): boolean {
    if (this.config.allowlist.length === 0) return false;
    return this.config.allowlist.includes(userId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  async notifyAll(text: string): Promise<void> {
    const chatIds = getKnownUserChatIds(this.db);
    await Promise.all(chatIds.map(chatId => this.reply(chatId, text)));
  }

  async sendApprovalRequest(request: ApprovalRequestRow): Promise<void> {
    const text =
      `Approval required\n\n${request.action}\n${request.context}\n\n` +
      `Approve: /approve ${request.id}\nDeny: /deny ${request.id}`;
    await this.notifyAll(text);
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.from) return;

    const userId = msg.from.id;

    if (!this.isAllowed(userId)) {
      return;
    }

    upsertKnownUser(this.db, userId, msg.chat.id);

    const text = msg.text ?? '';
    const parsed = parseCommandText(text);

    if (parsed) {
      await this.handleCommand(msg, parsed.command, parsed.rest);
    } else if (text) {
      await this.handleText(msg);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdatesFn(this.offset, 30);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch {
        await new Promise<void>(r => setTimeout(r, 5000));
      }
    }
  }

  private async handleCommand(msg: TgMessage, command: string, rest: string): Promise<void> {
    switch (command) {
      case 'session': {
        const parts = rest.split(/\s+/);
        const sub = parts[0]?.toLowerCase() ?? '';
        const arg = parts.slice(1).join(' ').trim();
        switch (sub) {
          case 'new': await this.cmdSessionNew(msg, arg); break;
          case 'list': await this.cmdSessionList(msg); break;
          case 'switch': await this.cmdSessionSwitch(msg, arg); break;
          case 'delete': await this.cmdSessionDelete(msg, arg); break;
          default: await this.reply(msg.chat.id, 'Unknown session subcommand. Use: new, list, switch, delete');
        }
        break;
      }
      case 'repo': await this.cmdRepo(msg, rest); break;
      case 'plan': await this.cmdPlan(msg); break;
      case 'submit': await this.cmdSubmit(msg); break;
      case 'approve': await this.cmdApprove(msg, rest); break;
      case 'deny': await this.cmdDeny(msg, rest); break;
      case 'start':
        await this.reply(msg.chat.id, 'Welcome to executr bot!\nUse /session new <name> to start a planning session.');
        break;
      default:
        await this.reply(msg.chat.id, `Unknown command: /${command}`);
    }
  }

  private async cmdSessionNew(msg: TgMessage, name: string): Promise<void> {
    if (!name) {
      await this.reply(msg.chat.id, 'Usage: /session new <name>');
      return;
    }
    const userId = msg.from!.id;
    const now = Date.now();
    const session: TelegramSessionRow = {
      id: randomUUID(),
      telegramUserId: userId,
      telegramChatId: msg.chat.id,
      sessionName: name,
      targetRepo: null,
      transcript: [],
      draftPlan: null,
      status: 'active',
      isCurrent: false,
      createdAt: now,
      updatedAt: now,
    };
    insertTelegramSession(this.db, session);
    setCurrentSession(this.db, userId, session.id);
    await this.reply(msg.chat.id, `Session "${name}" created and set as active.\nUse /repo <name> to set the target repo.`);
  }

  private async cmdSessionList(msg: TgMessage): Promise<void> {
    const userId = msg.from!.id;
    const sessions = getTelegramSessionsForUser(this.db, userId);
    if (sessions.length === 0) {
      await this.reply(msg.chat.id, 'No sessions. Use /session new <name> to create one.');
      return;
    }
    const lines = sessions.map(s =>
      `${s.isCurrent ? '>' : ' '} [${s.id.slice(0, 8)}] ${s.sessionName} (${s.status})${s.targetRepo ? ' — ' + s.targetRepo : ''}`
    );
    await this.reply(msg.chat.id, 'Sessions:\n' + lines.join('\n'));
  }

  private async cmdSessionSwitch(msg: TgMessage, nameOrId: string): Promise<void> {
    if (!nameOrId) {
      await this.reply(msg.chat.id, 'Usage: /session switch <id|name>');
      return;
    }
    const userId = msg.from!.id;
    const sessions = getTelegramSessionsForUser(this.db, userId);
    const target = sessions.find(s =>
      s.id === nameOrId || s.id.startsWith(nameOrId) || s.sessionName === nameOrId
    );
    if (!target) {
      await this.reply(msg.chat.id, `Session not found: ${nameOrId}`);
      return;
    }
    setCurrentSession(this.db, userId, target.id);
    await this.reply(msg.chat.id, `Switched to session "${target.sessionName}".`);
  }

  private async cmdSessionDelete(msg: TgMessage, nameOrId: string): Promise<void> {
    if (!nameOrId) {
      await this.reply(msg.chat.id, 'Usage: /session delete <id|name>');
      return;
    }
    const userId = msg.from!.id;
    const sessions = getTelegramSessionsForUser(this.db, userId);
    const target = sessions.find(s =>
      s.id === nameOrId || s.id.startsWith(nameOrId) || s.sessionName === nameOrId
    );
    if (!target) {
      await this.reply(msg.chat.id, `Session not found: ${nameOrId}`);
      return;
    }
    updateTelegramSession(this.db, target.id, { status: 'abandoned' });
    await this.reply(msg.chat.id, `Session "${target.sessionName}" deleted.`);
  }

  private async cmdRepo(msg: TgMessage, repo: string): Promise<void> {
    if (!repo) {
      await this.reply(msg.chat.id, 'Usage: /repo <repo>');
      return;
    }
    const userId = msg.from!.id;
    const session = getCurrentSessionForUser(this.db, userId);
    if (!session) {
      await this.reply(msg.chat.id, 'No active session. Use /session new <name> first.');
      return;
    }
    updateTelegramSession(this.db, session.id, { targetRepo: repo });
    await this.reply(msg.chat.id, `Target repo set to "${repo}".`);
  }

  private async cmdPlan(msg: TgMessage): Promise<void> {
    const userId = msg.from!.id;
    const session = getCurrentSessionForUser(this.db, userId);
    if (!session) {
      await this.reply(msg.chat.id, 'No active session. Use /session new <name> first.');
      return;
    }
    if (session.transcript.length === 0) {
      await this.reply(msg.chat.id, 'No conversation in this session yet. Share your ideas first.');
      return;
    }
    if (!session.targetRepo) {
      await this.reply(msg.chat.id, 'No target repo set. Use /repo <name> first.');
      return;
    }

    await this.reply(msg.chat.id, 'Generating plan from session transcript...');

    let draftResult: { markdown: string; valid: boolean; warnings: string[] };

    if (this.runner) {
      const planningSession: PlanningSession = {
        transcript: session.transcript,
        targetRepo: session.targetRepo,
        sessionName: session.sessionName,
      };
      draftResult = await this.runner.draftPlan(planningSession, session.targetRepo);
    } else {
      // Fallback: generate a simple template plan
      const title = session.sessionName;
      draftResult = {
        markdown: `# Plan: ${title}\n\n## Validation Commands\n\n\`\`\`\npnpm test\n\`\`\`\n\n### Task 1: Implement ${title}\n\n- [ ] Implement the following based on the planning session:\n${session.transcript.map(t => `  - ${t}`).join('\n')}\n`,
        valid: true,
        warnings: [],
      };
    }

    updateTelegramSession(this.db, session.id, { draftPlan: draftResult.markdown });

    const preview = draftResult.markdown.slice(0, 800);
    const truncated = draftResult.markdown.length > 800 ? '\n...(truncated)' : '';
    const warnings = draftResult.warnings.length > 0
      ? '\n\nWarnings: ' + draftResult.warnings.join(', ')
      : '';
    await this.reply(msg.chat.id, `Draft plan:\n\n${preview}${truncated}${warnings}\n\nUse /submit to submit.`);
  }

  private async cmdSubmit(msg: TgMessage): Promise<void> {
    const userId = msg.from!.id;
    const session = getCurrentSessionForUser(this.db, userId);
    if (!session) {
      await this.reply(msg.chat.id, 'No active session. Use /session new <name> first.');
      return;
    }
    if (!session.draftPlan) {
      await this.reply(msg.chat.id, 'No draft plan. Use /plan to generate one first.');
      return;
    }
    if (!session.targetRepo) {
      await this.reply(msg.chat.id, 'No target repo set. Use /repo <name> first.');
      return;
    }

    const outcome = submitRawPlan({
      workspaceRoot: this.workspaceRoot,
      claimsDir: this.claimsDir,
      repo: session.targetRepo,
      markdown: session.draftPlan,
    });

    if (!outcome.ok) {
      await this.reply(msg.chat.id, `Submission failed: ${outcome.error}`);
      return;
    }

    updateTelegramSession(this.db, session.id, { status: 'submitted' });
    await this.reply(msg.chat.id, `Plan "${outcome.planName}" submitted to ${session.targetRepo}!`);
  }

  private async cmdApprove(msg: TgMessage, id: string): Promise<void> {
    if (!id) {
      await this.reply(msg.chat.id, 'Usage: /approve <id>');
      return;
    }
    const requests = listApprovalRequests(this.db);
    const request = requests.find(r => r.id === id || r.id.startsWith(id));
    if (!request) {
      await this.reply(msg.chat.id, `Approval request not found: ${id}`);
      return;
    }
    if (request.status !== 'pending') {
      await this.reply(msg.chat.id, `Already decided: ${request.status}`);
      return;
    }
    const decidedBy = `telegram:${msg.from!.id}`;
    updateApprovalRequestStatus(this.db, request.id, 'approved', decidedBy);
    await this.reply(msg.chat.id, `Approved: ${request.action} (${request.id.slice(0, 8)})`);
  }

  private async cmdDeny(msg: TgMessage, id: string): Promise<void> {
    if (!id) {
      await this.reply(msg.chat.id, 'Usage: /deny <id>');
      return;
    }
    const requests = listApprovalRequests(this.db);
    const request = requests.find(r => r.id === id || r.id.startsWith(id));
    if (!request) {
      await this.reply(msg.chat.id, `Approval request not found: ${id}`);
      return;
    }
    if (request.status !== 'pending') {
      await this.reply(msg.chat.id, `Already decided: ${request.status}`);
      return;
    }
    const decidedBy = `telegram:${msg.from!.id}`;
    updateApprovalRequestStatus(this.db, request.id, 'denied', decidedBy);
    await this.reply(msg.chat.id, `Denied: ${request.action} (${request.id.slice(0, 8)})`);
  }

  private async handleText(msg: TgMessage): Promise<void> {
    const userId = msg.from!.id;
    const session = getCurrentSessionForUser(this.db, userId);
    if (!session) {
      await this.reply(msg.chat.id, 'No active session. Use /session new <name> to start planning.');
      return;
    }
    const transcript = [...session.transcript, msg.text ?? ''];
    updateTelegramSession(this.db, session.id, { transcript });
    await this.reply(msg.chat.id, `Added to session "${session.sessionName}" (${transcript.length} messages).`);
  }

  private async reply(chatId: number, text: string): Promise<void> {
    await this.sendMessageFn(chatId, text);
  }
}
