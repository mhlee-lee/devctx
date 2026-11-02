import { detectSignals, isQuestion } from '../hooks/signals.ts';
import type { Audience, Enforcement, ItemType, SourceKind } from '../knowledge/types.ts';
import { RATE_LIMIT_ERROR, reportAnswerQuality, routeCall, type RouteOptions } from '../llm/router.ts';
import type { StateDb, StoredEvent } from '../state/db.ts';
import { splitSentences, stripPasted, today, tokenize, truncate } from '../util/text.ts';
import { isQuoteValid, redactSecrets, stripInvisible, unsupportedTerms } from './evidence.ts';
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
  /** Last day the rule applies (YYYY-MM-DD) when the developer gave an end date. */
  validUntil: string | null;
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
  /**
   * Prompts without an explicit marker that no model analyzed (none evaluated yet, every call
   * failed, `--no-llm`): left pending for a run with a model. Only a model can tell whether such a
   * prompt states a rule; the no-LLM fallback reads explicit markers only.
   */
  heldEventIds: string[];
  /** Held events of batches a model was called on and failed (not: no model to ask). */
  failedEventIds: string[];
}

export interface ExtractOptions {
  /**
   * Keep prompts without explicit markers pending when no model answers. False only when calls are
   * turned off by configuration: no model will ever read them.
   */
  holdImplicit?: boolean;
}

const BATCH_SIZE = 5;

/**
 * Batches of up to BATCH_SIZE, except that a prompt a model already failed on goes alone: a
 * failure counts against every prompt of its batch, and only the one that causes it should reach
 * the limit (see the worker's MAX_MODEL_FAILURES).
 */
function batchesOf(events: readonly StoredEvent[], db: StateDb): StoredEvent[][] {
  const out: StoredEvent[][] = [];
  let current: StoredEvent[] = [];
  for (const ev of events) {
    if (db.extractFailures(ev.id) > 0) {
      out.push([ev]);
      continue;
    }
    current.push(ev);
    if (current.length === BATCH_SIZE) {
      out.push(current);
      current = [];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function sourceKindOf(ev: StoredEvent): SourceKind {
  return ev.flags.includes('correction') ? 'user-correction' : 'user-instruction';
}

function messageText(ev: StoredEvent): string {
  return redactSecrets(stripInvisible(ev.prompt ?? ''));
}

// Korean particles a noun may carry ("주석은", "코드만", "최소한으로"), longest first.
const KO_PARTICLE = /(으로부터|에서부터|으로서|으로써|에게서|에서|에게|한테|으로|까지|부터|처럼|보다|마다|이나|이랑|은|는|이|가|을|를|의|에|로|와|과|도|만|랑)$/;
// Endings of a verb or adjective ("남긴다", "쓰고", "없는", "쓰지"): such a word names nothing.
const KO_PREDICATE = /(다|고|며|게|요|죠|야|어|아|해|돼|라|자|지|는|은|한|할|된|될|던|든|서|면)$/;
// Markers, adverbs and filler words that say how a rule applies, not what about.
const KO_STOPWORDS = new Set(['앞으로', '이제부터', '지금부터', '다음부터', '다음에도', '항상', '언제나', '매번', '절대', '반드시', '무조건', '경우', '때문', '그리고', '하지만', '그래서', '또는', '그냥', '이번', '우리', '다시', '먼저', '바로', '같이', '계속', '모두', '전부', '그대로', '아직', '이미', '정말', '너무']);

/** A Korean word as a topic: the noun with its particles cut off, or null for a predicate or filler. */
function koreanTopic(word: string): string | null {
  let stem = word;
  let cut = false;
  for (let m = stem.match(KO_PARTICLE); m && stem.length - m[0].length >= 2; m = stem.match(KO_PARTICLE)) {
    stem = stem.slice(0, -m[0].length);
    cut = true;
  }
  if (cut && KO_PARTICLE.test(stem) && stem.length === 2) return null; // "외에는": a one-syllable noun
  if (stem.length < 2 || KO_STOPWORDS.has(stem)) return null;
  if (!cut) return KO_PREDICATE.test(stem) ? null : stem;
  // "설명하는", "사용되는": a verb root before the ending that looked like a particle.
  if (/(하|되|있|없|않|같)$/.test(stem)) return null;
  // "봐서는", "쓰지도", "해야만": a verb root without a final consonant, an ending, then a particle.
  const first = (stem.codePointAt(0) ?? 0) - 0xac00;
  return stem.length === 2 && first % 28 === 0 && /[서고야게지]$/.test(stem) ? null : stem;
}

/**
 * Topic words for a rule found without a model, most frequent first: Latin words of 3+ letters and
 * Korean nouns (particles cut off). Korean is read by word, not by syllable pair: pairs across a
 * particle ("코드만" -> "드만") name nothing.
 */
export function topicsFrom(text: string): string[] {
  const counts = new Map<string, number>();
  const add = (t: string): void => {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  };
  for (const t of tokenize(text.replace(/[\uac00-\ud7a3]+/g, ' '))) if (t.length >= 3) add(t);
  for (const m of text.normalize('NFKC').matchAll(/[\uac00-\ud7a3]+/g)) {
    const topic = koreanTopic(m[0]);
    if (topic) add(topic);
  }
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
    const sig = detectSignals(sentence, { implicit: false });
    if (!(sig.durable || sig.remember) || sig.oneOff || isQuestion(sentence)) continue;
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
      validUntil: null,
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
export async function extractCandidates(
  events: readonly StoredEvent[],
  db: StateDb,
  route: RouteOptions | null,
  opts: ExtractOptions = {},
): Promise<ExtractOutcome> {
  const outcome: ExtractOutcome = { candidates: [], usedLlm: false, provider: null, errors: [], deferredEventIds: [], heldEventIds: [], failedEventIds: [] };
  const holdImplicit = route !== null || opts.holdImplicit === true;
  // No model answered a batch: later batches of this call are not sent (the same answer, or more
  // failing calls on a backlog); they get the no-model treatment.
  let unanswered = false;
  const unsupportedNames = new Set<Candidate>();
  for (const batch of batchesOf(events, db)) {
    const messages: ExtractMessage[] = batch.map((ev, i) => ({
      index: i + 1,
      tool: ev.tool,
      date: ev.ts.slice(0, 10),
      message: messageText(ev),
      // An accepted proposal read from the transcript is kept on the prompt row itself.
      previousAssistant:
        ev.kind === 'prompt' ? (redactSecrets(ev.lastAssistant ?? db.lastAssistantBefore(ev.session, ev.ts) ?? '') || null) : null,
    }));
    let items = null;
    let called = false;
    if (route && !unanswered) {
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
        unanswered = true;
        called = res.called === true;
      }
    }
    if (!items) {
      for (const ev of batch) {
        // Without a model only explicit markers are read: a prompt without one waits for a model
        // (dropped unanalyzed after memory.unprocessed_retention_days).
        if (ev.flags.includes('implicit') && holdImplicit) {
          outcome.heldEventIds.push(ev.id);
          if (called) outcome.failedEventIds.push(ev.id);
          continue;
        }
        // `devctx remember` text is the rule as written (explicitRemember), not cut into the
        // sentences that carry a marker.
        if (ev.flags.includes('remember-cmd')) continue;
        outcome.candidates.push(...heuristicCandidates(ev));
      }
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
      // An end date before the message was written is a misread, not a rule that never applied.
      const validUntil = item.valid_until && item.valid_until >= msg.date ? item.valid_until : null;
      if (validUntil && validUntil < today()) continue; // already over (backlog processed late)
      let confidence = item.confidence;
      const unsupported = unsupportedTerms(item.statement, [msg.message, msg.previousAssistant]);
      if (unsupported.length > 0) {
        confidence = Math.min(confidence, 0.5); // stays a proposal until the developer says it again
        outcome.errors.push(`kept as proposed, names not in the message (${unsupported.slice(0, 3).join(', ')}): ${truncate(item.statement, 60)}`);
      }
      const candidate: Candidate = {
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
        validUntil,
        confidence,
        sourceKind: sourceKindOf(ev),
      };
      if (unsupported.length > 0) unsupportedNames.add(candidate);
      outcome.candidates.push(candidate);
    }
  }
  explicitRemember(events, outcome, unsupportedNames);
  return outcome;
}

/**
 * `devctx remember "<text>"` is the developer deciding on purpose: its rules are durable (active
 * right away), and when no model answered or extraction found nothing the whole text is the rule
 * (several sentences stay one rule). Statements naming things the text doesn't (kept low by the
 * check above) still wait for confirmation.
 */
function explicitRemember(events: readonly StoredEvent[], outcome: ExtractOutcome, unsupportedNames: ReadonlySet<Candidate>): void {
  const deferred = new Set(outcome.deferredEventIds);
  for (const ev of events) {
    if (!ev.flags.includes('remember-cmd') || deferred.has(ev.id)) continue;
    const own = outcome.candidates.filter((c) => c.eventId === ev.id);
    for (const c of own) {
      c.durability = 'durable';
      if (!unsupportedNames.has(c)) c.confidence = Math.max(c.confidence, 0.9);
    }
    if (own.length > 0) continue;
    const text = stripPasted(messageText(ev)).replace(/\s+/g, ' ').trim();
    if (text.length < 4) continue;
    const statement = truncate(text, 300);
    outcome.candidates.push({
      eventId: ev.id,
      tool: ev.tool,
      title: truncate(text, 40),
      statement,
      type: 'rule',
      enforcement: /절대|반드시|\bnever\b|\bmust\b/i.test(text) ? 'must' : 'should',
      durability: 'durable',
      audience: /(나한테|저한테|나에게|저에게|\bto me\b|\bwith me\b)/i.test(text) ? 'personal' : 'team',
      scope: { paths: [], topics: topicsFrom(text) },
      evidenceQuote: truncate(text, 200),
      reason: null,
      validUntil: null,
      confidence: 0.9,
      sourceKind: 'user-instruction',
    });
  }
}
