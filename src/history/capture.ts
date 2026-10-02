import { promptKind } from '../hooks/context.ts';
import type { HookEvent } from '../hooks/normalize.ts';
import type { StateDb } from '../state/db.ts';
import type { HookKind, Language } from '../types.ts';
import { snapshotWorktree } from './snapshot.ts';
import { historyEnabled } from './toggle.ts';

/** One history file per session; tools without a session id get one per tool and day. */
export function historyKey(tool: string, session: string | null, ts: string): string {
  return session ? `${tool}:${session}` : `${tool}:day:${ts.slice(0, 10)}`;
}

/**
 * Hook side of the prompt history. A prompt opens a turn with a snapshot of the working tree; the
 * turn's end (or the session's, or the next prompt when the tool never reported an end) closes it
 * with a second snapshot. Returns true when a turn is ready for the worker to write.
 */
export function captureHistory(root: string, db: StateDb, kind: HookKind, event: HookEvent): boolean {
  const skey = historyKey(event.tool, event.session, event.ts);
  if (kind === 'prompt') {
    if (!event.prompt || promptKind(event.prompt) === 'command' || !historyEnabled(root)) return false;
    const snap = snapshotWorktree(root);
    const open = db.openHistoryTurnOf(skey);
    if (open) db.closeHistoryTurn(open.id, { endTs: event.ts, afterTree: snap.tree, lastAssistant: null, transcriptPath: event.transcriptPath });
    db.openHistoryTurn({
      tool: event.tool,
      session: event.session,
      skey,
      model: event.model,
      branch: snap.branch,
      promptTs: event.ts,
      prompt: event.prompt,
      beforeTree: snap.tree,
      transcriptPath: event.transcriptPath,
    });
    return open !== null;
  }
  if (kind === 'turn_end' || kind === 'session_end') {
    // Closed even if history was turned off meanwhile: the prompt was recorded while it was on.
    const open = db.openHistoryTurnOf(skey);
    if (!open) return false;
    const snap = snapshotWorktree(root);
    db.closeHistoryTurn(open.id, { endTs: event.ts, afterTree: snap.tree, lastAssistant: event.lastAssistant, transcriptPath: event.transcriptPath });
    return true;
  }
  return false;
}

const NOTICE: Record<Language, string> = {
  ko: '프롬프트 히스토리 기록이 켜져 있다: 이 세션의 프롬프트 원문과 작업 요약이 .devctx/history/에 저장되고 커밋에 함께 올라간다 (끄기: devctx history off).',
  en: 'Prompt history is on: prompts of this session (verbatim) and a summary of the work go to .devctx/history/ and ride along with commits (turn off: devctx history off).',
};

export function historyNotice(lang: Language): string {
  return NOTICE[lang];
}
