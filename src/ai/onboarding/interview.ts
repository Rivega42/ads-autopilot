import { BriefStatus, type Prisma, type PrismaClient } from '@prisma/client';

import {
  BRIEF_FIELD_LABELS,
  briefWarnings,
  missingBriefFields,
  parseCompleteBrief,
  type BriefField,
  type ClientBriefData,
  type ClientBriefDraft,
} from './brief.schema.js';
import {
  emptyTranscript,
  lastAssistantTurn,
  parseDraft,
  parseTranscript,
  toJsonValue,
  toLlmMessages,
  userMessages,
  type InterviewTranscript,
} from './state.js';
import { interviewTurnSchema, type InterviewTurn } from './turn.schema.js';
import { applyTurnUpdates } from './updates.js';

import { loadPrompt } from '@/ai/prompt-loader.js';
import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import { runAgent } from '@/clients/llm/index.js';
import { prisma } from '@/db/prisma.js';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ai:onboarding' });

/**
 * AI-онбординг (TZ §13.1): адаптивное интервью в Telegram, на выходе — заполненный
 * `ClientBrief`.
 *
 * Машина состояний живёт в БД целиком. Каждый ход — это «прочитали строку → сходили
 * в модель → записали строку»; между ходами процесс может умереть, и ничего не
 * потеряется. Поэтому у модуля нет ни кеша в памяти, ни сессий: Telegram-слою
 * достаточно знать clientId.
 */

export const AGENT_NAME = 'onboarding';

/**
 * Жёсткий потолок ходов. ТЗ обещает 15-20 вопросов — это ориентир для промпта,
 * а не для кода; здесь нужен предохранитель от бесконечного диалога, в котором
 * модель и клиент не могут договориться и жгут бюджет.
 */
export const MAX_QUESTIONS = 25;

/** Ответ клиента длиннее этого обрезаем: в TG прилетают простыни, а transcript в Json. */
const MAX_ANSWER_CHARS = 4_000;

/** Только `clientBrief`: агенту не нужен доступ ко всей БД, а тестам — весь PrismaClient. */
export type BriefStore = Pick<PrismaClient, 'clientBrief'>;

/** Ровно тот же вызов, что делает `runAgent`, но не генерик — так его проще подменить. */
export type RunInterviewTurn = (
  opts: RunAgentOptions<InterviewTurn>,
) => Promise<AgentRun<InterviewTurn>>;

export interface InterviewDeps {
  db?: BriefStore;
  /** Подменяется в тестах и в evals; в проде — `runAgent` из LLM-ядра. */
  run?: RunInterviewTurn;
  now?: () => Date;
}

export type InterviewStep =
  | {
      kind: 'question';
      /** Текст для отправки клиенту. */
      text: string;
      askedCount: number;
      missing: BriefField[];
      /** true — вопрос восстановлен из БД после перезапуска, модель не вызывалась. */
      resumed: boolean;
    }
  | {
      kind: 'complete';
      text: string;
      brief: ClientBriefData;
      /** Формально бриф валиден, но на это стоит посмотреть человеку. */
      warnings: string[];
    }
  | {
      kind: 'needs_human';
      text: string;
      missing: BriefField[];
      askedCount: number;
    };

export interface InterviewSnapshot {
  status: BriefStatus;
  askedCount: number;
  missing: BriefField[];
  draft: ClientBriefDraft;
  /** Заполнен только для завершённого интервью. */
  brief: ClientBriefData | null;
  lastQuestion: string | null;
  updatedAt: Date;
}

/** Второй ход по тому же брифу, пока первый не дописал результат. */
export class InterviewConflictError extends AppError {
  constructor(clientId: string) {
    super(`Interview for client ${clientId} was modified concurrently`, {
      code: 'INTERVIEW_CONFLICT',
      retryable: true,
      context: { clientId },
    });
  }
}

export class InterviewNotStartedError extends AppError {
  constructor(clientId: string) {
    super(`Interview for client ${clientId} was not started`, {
      code: 'INTERVIEW_NOT_STARTED',
      context: { clientId },
    });
  }
}

interface BriefRow {
  id: string;
  clientId: string;
  status: BriefStatus;
  data: Prisma.JsonValue;
  transcript: Prisma.JsonValue | null;
  updatedAt: Date;
}

/**
 * Начинает интервью или возвращает то место, на котором оно прервалось.
 *
 * Повторный вызов безопасен: для собранного брифа вернётся `complete` без обращения
 * к модели, для незаконченного — последний заданный вопрос.
 */
export async function startInterview(
  clientId: string,
  deps: InterviewDeps = {},
): Promise<InterviewStep> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());

  let row = await findRow(db, clientId);

  if (row === null) {
    row = await createRow(db, clientId);
  }

  if (row.status === BriefStatus.COMPLETE) return completedStep(row);

  const transcript = parseTranscript(row.transcript);
  const last = lastAssistantTurn(transcript);
  if (last !== undefined) {
    const draft = parseDraft(row.data);
    log.info({ clientId, askedCount: transcript.askedCount }, 'resuming onboarding interview');
    return {
      kind: 'question',
      text: last.text,
      askedCount: transcript.askedCount,
      missing: missingBriefFields(draft),
      resumed: true,
    };
  }

  return advance({
    clientId,
    row,
    draft: parseDraft(row.data),
    transcript,
    db,
    run: deps.run ?? runAgent,
    now,
  });
}

/**
 * Принимает ответ клиента и возвращает следующий шаг интервью.
 *
 * @throws {InterviewNotStartedError} если `startInterview` ещё не вызывался
 * @throws {InterviewConflictError} если строку успел изменить другой ход
 */
export async function handleAnswer(
  clientId: string,
  answer: string,
  deps: InterviewDeps = {},
): Promise<InterviewStep> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());

  const text = answer.trim().slice(0, MAX_ANSWER_CHARS);
  if (text === '') {
    throw new AppError('Empty answer', { code: 'EMPTY_ANSWER', context: { clientId } });
  }

  const row = await findRow(db, clientId);
  if (row === null) throw new InterviewNotStartedError(clientId);
  if (row.status === BriefStatus.COMPLETE) return completedStep(row);

  const transcript = parseTranscript(row.transcript);
  transcript.turns.push({ role: 'user', text, at: now().toISOString() });

  return advance({
    clientId,
    row,
    draft: parseDraft(row.data),
    transcript,
    db,
    run: deps.run ?? runAgent,
    now,
  });
}

/** Состояние интервью для Telegram-слоя: нужно, чтобы понять, чей это текст. */
export async function getInterviewState(
  clientId: string,
  deps: InterviewDeps = {},
): Promise<InterviewSnapshot | null> {
  const db = deps.db ?? prisma;
  const row = await findRow(db, clientId);
  if (row === null) return null;

  const draft = parseDraft(row.data);
  const transcript = parseTranscript(row.transcript);
  const parsed = parseCompleteBrief(draft);

  return {
    status: row.status,
    askedCount: transcript.askedCount,
    missing: missingBriefFields(draft),
    draft,
    brief: row.status === BriefStatus.COMPLETE && parsed.ok ? parsed.brief : null,
    lastQuestion: lastAssistantTurn(transcript)?.text ?? null,
    updatedAt: row.updatedAt,
  };
}

interface AdvanceContext {
  clientId: string;
  row: BriefRow;
  draft: ClientBriefDraft;
  transcript: InterviewTranscript;
  db: BriefStore;
  run: RunInterviewTurn;
  now: () => Date;
}

/** Один ход интервьюера: спросить модель, принять обновления, записать результат. */
async function advance(ctx: AdvanceContext): Promise<InterviewStep> {
  const { clientId, transcript } = ctx;

  const missingBefore = missingBriefFields(ctx.draft);
  const prompt = loadPrompt('onboarding-interview', {
    knownBrief: JSON.stringify(ctx.draft, null, 2),
    missingFields: formatFields(missingBefore),
    askedCount: transcript.askedCount,
    maxQuestions: MAX_QUESTIONS,
  });

  const run = await ctx.run({
    agent: AGENT_NAME,
    task: 'onboarding.interview',
    clientId,
    system: prompt.text,
    messages: toLlmMessages(transcript),
    schema: interviewTurnSchema,
    schemaName: 'onboarding.turn',
    // Живой диалог не кешируем: одинаковое начало у двух клиентов не повод отдать
    // второму ответ, собранный по контексту первого.
    cache: false,
  });

  const turn: InterviewTurn = run.data;
  const { draft, rejected } = applyTurnUpdates(ctx.draft, turn, userMessages(transcript));

  for (const item of rejected) {
    log.warn({ clientId, ...item }, 'onboarding: update rejected, no quote from the client');
  }

  transcript.askedCount += 1;
  transcript.turns.push({
    role: 'assistant',
    text: turn.reply,
    at: ctx.now().toISOString(),
    aiRunId: run.aiRunId,
    promptVersion: prompt.version,
    asking: turn.asking ?? null,
  });

  const missing = missingBriefFields(draft);
  const parsed = missing.length === 0 ? parseCompleteBrief(draft) : null;

  if (turn.done && missing.length > 0) {
    // Решает схема, а не модель: «done» при незаполненных полях означало бы бриф,
    // в котором чего-то не хватает, — и следующий агент дофантазировал бы это сам.
    log.warn({ clientId, missing }, 'onboarding: model claimed completion too early');
  }

  const complete = parsed?.ok === true;
  const completedAt = complete ? ctx.now() : null;

  await persist(ctx.db, ctx.row, {
    // Готовый бриф пишем в том виде, в каком его вернула схема: дальше его читают
    // стратег и креативы, и им должно достаться ровно провалидированное значение.
    data: toJsonValue(parsed?.ok === true ? parsed.brief : draft),
    transcript: toJsonValue(transcript),
    status: complete ? BriefStatus.COMPLETE : BriefStatus.IN_PROGRESS,
    completedAt,
  });

  if (parsed?.ok === true) {
    const warnings = briefWarnings(parsed.brief);
    log.info(
      { clientId, askedCount: transcript.askedCount, warnings: warnings.length },
      'onboarding interview complete',
    );
    return { kind: 'complete', text: turn.reply, brief: parsed.brief, warnings };
  }

  if (transcript.askedCount >= MAX_QUESTIONS) {
    log.error({ clientId, missing }, 'onboarding: question budget exhausted, human needed');
    return {
      kind: 'needs_human',
      text: turn.reply,
      missing,
      askedCount: transcript.askedCount,
    };
  }

  return {
    kind: 'question',
    text: turn.reply,
    askedCount: transcript.askedCount,
    missing,
    resumed: false,
  };
}

interface BriefPatch {
  data: Prisma.InputJsonValue;
  transcript: Prisma.InputJsonValue;
  status: BriefStatus;
  completedAt: Date | null;
}

/**
 * Запись хода. `updateMany` по `updatedAt` вместо `update` по id — это оптимистичная
 * блокировка: два одновременных ответа клиента не должны затирать ходы друг друга,
 * а второй из них честнее отклонить, чем потерять.
 */
async function persist(db: BriefStore, row: BriefRow, patch: BriefPatch): Promise<void> {
  const { count } = await db.clientBrief.updateMany({
    where: { id: row.id, updatedAt: row.updatedAt },
    data: patch,
  });
  if (count === 0) throw new InterviewConflictError(row.clientId);
}

async function findRow(db: BriefStore, clientId: string): Promise<BriefRow | null> {
  return db.clientBrief.findUnique({
    where: { clientId },
    select: {
      id: true,
      clientId: true,
      status: true,
      data: true,
      transcript: true,
      updatedAt: true,
    },
  });
}

async function createRow(db: BriefStore, clientId: string): Promise<BriefRow> {
  try {
    return await db.clientBrief.create({
      data: {
        clientId,
        data: {},
        transcript: toJsonValue(emptyTranscript()),
      },
      select: {
        id: true,
        clientId: true,
        status: true,
        data: true,
        transcript: true,
        updatedAt: true,
      },
    });
  } catch (err) {
    // Гонка двух /start в одном чате: у ClientBrief.clientId уникальный индекс,
    // поэтому проигравший просто читает строку победителя.
    if (!isUniqueViolation(err)) throw err;
    const row = await findRow(db, clientId);
    if (row === null) throw err;
    return row;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

function completedStep(row: BriefRow): InterviewStep {
  const parsed = parseCompleteBrief(parseDraft(row.data));
  if (parsed.ok) {
    return {
      kind: 'complete',
      text: 'Бриф уже собран.',
      brief: parsed.brief,
      warnings: briefWarnings(parsed.brief),
    };
  }

  // Строка помечена COMPLETE, но данные схему не проходят — чинить это должен человек,
  // а не следующий вопрос модели.
  const missing = missingBriefFields(parseDraft(row.data));
  log.error({ clientId: row.clientId, issues: parsed.issues }, 'completed brief fails its schema');
  return {
    kind: 'needs_human',
    text: 'Бриф помечен как готовый, но не проходит проверку. Нужен человек.',
    missing,
    askedCount: 0,
  };
}

function formatFields(fields: readonly BriefField[]): string {
  if (fields.length === 0) return 'ничего — все обязательные поля собраны';
  return fields.map((field) => `- ${field}: ${BRIEF_FIELD_LABELS[field]}`).join('\n');
}
