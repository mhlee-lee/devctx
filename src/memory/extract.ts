import { detectSignals } from '../hooks/signals.ts';
import type { Audience, Enforcement, ItemType, SourceKind } from '../knowledge/types.ts';
import { RATE_LIMIT_ERROR, reportAnswerQuality, routeCall, type RouteOptions } from '../llm/router.ts';
import type { StateDb, StoredEvent } from '../state/db.ts';
import { splitSentences, stripPasted, tokenize, truncate } from '../util/text.ts';
import { isQuoteValid, redactSecrets, stripInvisible } from './evidence.ts';
import { buildExtractPrompt, EXTRACT_SCHEMA, parseExtractResult, type ExtractMessage } from './prompts.ts';

export interface Candidate {
  eventId: string;
  tool: string;
  title: string;
  statement: string;
  type: ItemType;
  enforcement: Enforcement;
  durability: 'durable' | 'one_off' | 'unclear';
  audience: Audience;
  scope: { paths: string[]; topics: string[] };
  evidenceQuote: string;
  reason: string | null;
  confidence: number;
  sourceKind: SourceKind;
}

export interface ExtractOutcome {
  candidates: Candidate[];
  usedLlm: boolean;
  provider: string | null;
  errors: string[];
  /** Events of batches that hit the hourly call limit: leave them pending for the next run. */
  deferredEventIds: string[];
}

const BATCH_SIZE = 5;

function sourceKindOf(ev: StoredEvent): SourceKind {
  return ev.flags.includes('correction') ? 'user-correction' : 'user-instruction';
}

function messageText(ev: StoredEvent): string {
  return redactSecrets(stripInvisible(ev.prompt ?? ''));
}

function topicsFrom(text: string): string[] {
  const counts = new Map<string, number>();
  for (const t of tokenize(text)) if (t.length >= 3 || /[\uac00-\ud7a3]/.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([t]) => t);
}

/**
 * Fallback when no LLM is reachable: keep only sentences with explicit durable markers, as
 * low-confidence `proposed` items. They become active only if the user repeats them.
 */
export function heuristicCandidates(ev: StoredEvent): Candidate[] {
  const out: Candidate[] = [];
  for (const sentence of splitSentences(stripPasted(messageText(ev)))) {
    const sig = detectSignals(sentence);
    if (!(sig.durable || sig.remember) || sig.oneOff) continue;
    if (sentence.length < 6 || sentence.length > 300) continue;
    out.push({
      eventId: ev.id,
      tool: ev.tool,
      title: truncate(sentence, 40),
      statement: sentence,
      type: 'rule',
      enforcement: /절대|반드시|\bnever\b|\bmust\b/i.test(sentence) ? 'must' : 'should',
      durability: 'unclear',
      audience: /(나한테|저한테|나에게|저에게|\bto me\b|\bwith me\b)/i.test(sentence) ? 'personal' : 'team',
      scope: { paths: [], topics: topicsFrom(sentence) },
      evidenceQuote: sentence,
      reason: null,
      confidence: 0.4,
      sourceKind: sourceKindOf(ev),
    });
  }
  return out.slice(0, 3);
}

/**
 * Turns captured prompts (and foreign edits) into validated candidates. Evidence quotes must be
 * verbatim substrings of what the developer typed; anything else is discarded.
 */
export async function extractCandidates(events: readonly StoredEvent[], db: StateDb, route: RouteOptions | null): Promise<ExtractOutcome> {
  const outcome: ExtractOutcome = { candidates: [], usedLlm: false, provider: null, errors: [], deferredEventIds: [] };
  for (let start = 0; start < events.length; start += BATCH_SIZE) {
    const batch = events.slice(start, start + BATCH_SIZE);
    const messages: ExtractMessage[] = batch.map((ev, i) => ({
      index: i + 1,
      tool: ev.tool,
      message: messageText(ev),
      previousAssistant:
        ev.kind === 'prompt' ? (redactSecrets(db.lastAssistantBefore(ev.session, ev.ts) ?? '') || null) : null,
    }));
    let items = null;
    if (route) {
      const res = await routeCall(
        {
          task: 'extract',
          prompt: buildExtractPrompt(messages, route.cfg.language),
          schema: EXTRACT_SCHEMA,
          timeoutMs: route.cfg.llm.timeout_seconds * 1000,
        },
        parseExtractResult,
        route,
      );
      if (res.ok) {
        items = res.value;
        outcome.usedLlm = true;
        outcome.provider = res.model;
        // Production check of the same requirements the suite tests: quotes must be verbatim and
        // items must point at a message of this batch. Repeated misses demote the model.
        const broken = items.filter((item) => {
          const msg = messages.find((m) => m.index === item.message);
          return !msg || !isQuoteValid(msg.message, item.evidence_quote);
        }).length;
        reportAnswerQuality(res.model, 'extract', broken > 0 ? `${broken} item(s) without verbatim evidence` : null);
      } else if (res.error === RATE_LIMIT_ERROR) {
        outcome.deferredEventIds.push(...batch.map((ev) => ev.id));
        outcome.errors.push(res.error);
        continue;
      } else {
        outcome.errors.push(`${res.error}: ${res.attempts.slice(-3).join(' | ')}`);
      }
    }
    if (!items) {
      for (const ev of batch) outcome.candidates.push(...heuristicCandidates(ev));
      continue;
    }
    for (const item of items) {
      const msg = messages.find((m) => m.index === item.message);
      const ev = batch[item.message - 1];
      if (!msg || !ev) continue;
      if (!isQuoteValid(msg.message, item.evidence_quote)) {
        outcome.errors.push(`dropped item without verbatim evidence: ${truncate(item.statement, 60)}`);
        continue;
      }
      if (item.durability === 'one_off') continue;
      outcome.candidates.push({
        eventId: ev.id,
        tool: ev.tool,
        title: item.title,
        statement: stripInvisible(item.statement),
        type: item.type,
        enforcement: item.enforcement,
        durability: item.durability,
        audience: item.audience,
        scope: item.scope,
        evidenceQuote: truncate(item.evidence_quote, 200),
        reason: item.reason,
        confidence: item.confidence,
        sourceKind: sourceKindOf(ev),
      });
    }
  }
  return outcome;
}
