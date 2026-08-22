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
import { saveMetrikaConfig, type ClientConfigStore } from './metrika-config.js';
import {
  emptyTranscript,
  lastAssistantTurn,
  parseDraft,
  parseTranscript,
  toJsonValue,
  toLlmMessages,
  userMessages,
  type HaltReason,
  type InterviewTranscript,
} from './state.js';
import { interviewTurnSchema, type InterviewTurn } from './turn.schema.js';
import { applyTurnUpdates, mentionsWebAddress } from './updates.js';

import { loadPrompt } from '@/ai/prompt-loader.js';
import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import { runAgent } from '@/clients/llm/index.js';
import { prisma } from '@/db/prisma.js';
import { AppError, describeError } from '@/lib/errors.js';
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

/**
 * Сколько раз интервью спрашивает про ссылку на сайт, прежде чем сказать правду.
 *
 * Ссылка обязательна не по вкусу, а по протоколу: Директ принимает объявление
 * только с целью показа, и единственная, которую система умеет заполнить, — `Href`
 * (`campaigns/planner.ts`). У клиента без сайта ответа на этот вопрос нет ни на
 * третий раз, ни на двадцатый, поэтому потолок вопросов здесь не годится: он
 * означал бы двадцать оплаченных ходов и «нужен человек» в конце. Три попытки —
 * это шанс сходить за ссылкой и вернуться, дальше повторять вопрос бессмысленно.
 *
 * Считаются заданные вопросы, на которые клиент уже ответил, а не заданные плюс
 * текущий: иначе при значении 3 клиент успевал ответить дважды.
 */
export const LANDING_URL_ATTEMPTS = 3;

/**
 * Что слышит клиент, у которого сайта нет.
 *
 * Худший вариант — молчаливое «бриф собран» и отказ на создании кампании: клиент
 * прошёл интервью, потратил своё время и наши деньги на модель и остался ни с чем.
 */
export const NO_LANDING_REPLY =
  'Без ссылки на сайт или посадочную страницу кампанию в Яндекс Директе завести ' +
  'не получится: он не принимает объявление, которому некуда вести, а визитку и ' +
  'турбо-страницы мы пока не делаем. Остальное я записал — как появится ссылка, ' +
  'пришли её сюда, и мы продолжим с этого места.';

/**
 * Что слышит клиент, у которого сайт есть, а записать адрес мы не смогли.
 *
 * Отказ нашей проверки — не отсутствие сайта. Сказать человеку с работающим сайтом
 * «Директ не примет объявление» значит потерять клиента на ровном месте, поэтому
 * здесь другой текст и другая причина остановки: разбирается человек, а не клиент.
 */
export const UNCONFIRMED_LANDING_REPLY =
  'Ссылку я вижу, но записать её автоматически не смог и не хочу отправить рекламу ' +
  'не туда. Остальное по брифу собрано — с адресом разберётся человек и вернётся ' +
  'к тебе. Если проще прислать ссылку ещё раз обычным текстом — пришли, я попробую снова.';

/** Что слышит клиент, который пишет в остановленное интервью. */
const HALT_REPEAT_REPLY: Readonly<Record<HaltReason, string>> = {
  'no-landing':
    'Пока по брифу пауза: без ссылки на сайт продолжать нечем. Пришли ссылку сюда — ' +
    'и я сразу вернусь к вопросам.',
  'unconfirmed-landing':
    'По брифу пауза: адрес сайта ушёл на проверку человеку. Ещё раз прислать ссылку ' +
    'текстом можно в любой момент — тогда попробую записать сам.',
};

const HALT_REPLY: Readonly<Record<HaltReason, string>> = {
  'no-landing': NO_LANDING_REPLY,
  'unconfirmed-landing': UNCONFIRMED_LANDING_REPLY,
};

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
  /**
   * Карточка клиента. Отдельно от `db`: бриф и конфигурация — разные строки и
   * разные владельцы, а хранилище брифа умышленно сужено до одной модели.
   */
  clients?: ClientConfigStore;
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
  /**
   * Ждёт ли интервью следующего сообщения клиента.
   *
   * Отдельно от `status`, потому что COMPLETE — ещё не конец разговора: бриф,
   * собранный до того, как ссылка стала обязательной, помечен готовым, а спросить
   * его надо. Telegram-слой решает по этому полю, чей это текст: без него ответ
   * клиента проходил мимо интервью.
   */
  expectsAnswer: boolean;
  /** Интервью остановлено до вмешательства человека: модель больше не зовём. */
  haltedReason: HaltReason | null;
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

  const reopen = reopenableFields(row);
  if (row.status === BriefStatus.COMPLETE && reopen.length === 0) return completedStep(row);
  if (reopen.length > 0) {
    // Последний ход такой строки — «бриф собран», и вернуть его значило бы повторить
    // тупик: интервью обязано задать недостающий вопрос, а не подтвердить готовность.
    log.info({ clientId, missing: reopen }, 'reopening a brief completed before the field existed');
    return advance({
      clientId,
      row,
      draft: parseDraft(row.data),
      transcript: parseTranscript(row.transcript),
      db,
      clients: deps.clients,
      run: deps.run ?? runAgent,
      now,
    });
  }

  const transcript = parseTranscript(row.transcript);
  const halted = transcript.halted;
  if (halted !== null && halted !== undefined) return haltedStep(row, transcript, halted.reason);

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
    clients: deps.clients,
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
  if (row.status === BriefStatus.COMPLETE && reopenableFields(row).length === 0) {
    return completedStep(row);
  }

  const transcript = parseTranscript(row.transcript);
  const halted = transcript.halted;
  transcript.turns.push({ role: 'user', text, at: now().toISOString() });

  if (halted !== null && halted !== undefined) {
    // Ссылка снимает паузу: она — единственное, чего интервью ждёт. Всё остальное
    // («ладно», «а без сайта никак?», «спасибо») записываем и не платим за модель:
    // её ответ всё равно был бы заменён константой.
    if (!mentionsWebAddress(text)) {
      return haltedRepeat({ clientId, row, transcript, db, now }, halted.reason);
    }
    transcript.halted = null;
    log.info({ clientId, reason: halted.reason }, 'onboarding: halt lifted, client sent a link');
  }

  return advance({
    clientId,
    row,
    draft: parseDraft(row.data),
    transcript,
    db,
    clients: deps.clients,
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

  const missing = missingBriefFields(draft);

  return {
    status: row.status,
    askedCount: transcript.askedCount,
    missing,
    draft,
    brief: row.status === BriefStatus.COMPLETE && parsed.ok ? parsed.brief : null,
    lastQuestion: lastAssistantTurn(transcript)?.text ?? null,
    expectsAnswer: row.status !== BriefStatus.COMPLETE || reopenableFields(row).length > 0,
    haltedReason: transcript.halted?.reason ?? null,
    updatedAt: row.updatedAt,
  };
}

/**
 * Чего не хватает брифу, который помечен готовым.
 *
 * Пусто у настоящего готового брифа и у строки, которая не проходит схему: первую
 * доспрашивать не о чем, вторую должен чинить человек, а не следующий вопрос модели.
 * Непусто ровно там, где поле стало обязательным после того, как бриф собрали, —
 * `metrika` и `landingUrl` необязательны в схеме, но обязательны в
 * `REQUIRED_BRIEF_FIELDS`.
 */
function reopenableFields(row: BriefRow): BriefField[] {
  if (row.status !== BriefStatus.COMPLETE) return [];
  const draft = parseDraft(row.data);
  if (!parseCompleteBrief(draft).ok) return [];
  return missingBriefFields(draft);
}

interface AdvanceContext {
  clientId: string;
  row: BriefRow;
  draft: ClientBriefDraft;
  transcript: InterviewTranscript;
  db: BriefStore;
  clients: ClientConfigStore | undefined;
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
  const answers = userMessages(transcript);
  const { draft, rejected, corrected } = applyTurnUpdates(ctx.draft, turn, answers);

  for (const item of rejected) {
    log.warn({ clientId, ...item }, 'onboarding: update rejected, no quote from the client');
  }
  for (const item of corrected) {
    log.info({ clientId, ...item }, 'onboarding: value replaced with the one the client wrote');
  }

  const missing = missingBriefFields(draft);
  const parsed = missing.length === 0 ? parseCompleteBrief(draft) : null;

  // Поле, о котором спрашивает этот ход. Промпт заполнять `asking` не обязан, а на
  // нём держится весь счёт вопросов про ссылку; когда пробел в брифе остался один,
  // спрашивать больше не о чем — это и записываем. Ход, объявленный законченным,
  // вопросом не считается: иначе «бриф собран» при незаполненном поле уехало бы в
  // счётчик и отняло у клиента одну попытку.
  const inferredAsking = missing.length === 1 && turn.done !== true ? missing[0] : null;
  const asking = turn.asking ?? inferredAsking ?? null;

  // Считается по расшифровке, а не отдельным счётчиком в строке: поле, о котором
  // спрашивал каждый ход, там уже записано. Текущий вопрос не в счёт — на него
  // клиент ещё не отвечал.
  const landingAsks = countAsks(transcript, 'landingUrl');
  const outOfLandingAttempts =
    parsed?.ok !== true &&
    missing.includes('landingUrl') &&
    asking === 'landingUrl' &&
    landingAsks >= LANDING_URL_ATTEMPTS;

  // Клиент, назвавший адрес, сайт имеет — даже если записать этот адрес не вышло.
  // Разница не косметическая: одному система говорит «в Директе так нельзя»,
  // другому — «разберётся человек».
  const haltReason: HaltReason = answers.some(mentionsWebAddress)
    ? 'unconfirmed-landing'
    : 'no-landing';

  transcript.askedCount += 1;
  transcript.turns.push({
    role: 'assistant',
    // В расшифровку уезжает то же, что увидел клиент: иначе перезапуск повторил бы
    // ему вопрос модели вместо честного ответа (`startInterview` берёт текст отсюда).
    text: outOfLandingAttempts ? HALT_REPLY[haltReason] : turn.reply,
    at: ctx.now().toISOString(),
    aiRunId: run.aiRunId,
    promptVersion: prompt.version,
    asking,
  });

  if (outOfLandingAttempts) {
    // Без пометки каждое следующее «ладно» и «спасибо» снова уезжало бы в модель,
    // а её ответ всё равно заменялся бы этой же константой.
    transcript.halted = { reason: haltReason, at: ctx.now().toISOString() };
  }

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
    await persistMetrikaConfig(ctx, parsed.brief);
    const warnings = briefWarnings(parsed.brief);
    log.info(
      { clientId, askedCount: transcript.askedCount, warnings: warnings.length },
      'onboarding interview complete',
    );
    return { kind: 'complete', text: turn.reply, brief: parsed.brief, warnings };
  }

  if (outOfLandingAttempts) {
    if (haltReason === 'unconfirmed-landing') {
      log.error(
        { clientId, askedCount: transcript.askedCount, landingAsks },
        'onboarding: client named a site we could not record, human needed',
      );
    } else {
      log.warn(
        { clientId, askedCount: transcript.askedCount, landingAsks },
        'onboarding: client has no landing page, Direct campaign is impossible',
      );
    }
    return {
      kind: 'needs_human',
      text: HALT_REPLY[haltReason],
      missing,
      askedCount: transcript.askedCount,
    };
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

/**
 * Настройка Метрики из готового брифа.
 *
 * Отказ не роняет ход: бриф уже записан, а конфигурацию можно проставить руками
 * или следующим прогоном. Потерять из-за неё собранное интервью — худший обмен.
 */
async function persistMetrikaConfig(ctx: AdvanceContext, brief: ClientBriefData): Promise<void> {
  try {
    await saveMetrikaConfig(ctx.clientId, brief, ctx.clients);
  } catch (err) {
    log.error(
      { clientId: ctx.clientId, err: describeError(err) },
      'cannot save metrika config from the completed brief',
    );
  }
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

/** Остановленное интервью после перезапуска: тот же ответ, без вызова модели. */
function haltedStep(
  row: BriefRow,
  transcript: InterviewTranscript,
  reason: HaltReason,
): InterviewStep {
  return {
    kind: 'needs_human',
    text: HALT_REPLY[reason],
    missing: missingBriefFields(parseDraft(row.data)),
    askedCount: transcript.askedCount,
  };
}

interface HaltContext {
  clientId: string;
  row: BriefRow;
  transcript: InterviewTranscript;
  db: BriefStore;
  now: () => Date;
}

/**
 * Сообщение в остановленное интервью: записываем и отвечаем без модели.
 *
 * Записываем, потому что разбирать это будет человек — и по расшифровке, а не по
 * строчкам в логе; `askedCount` не растёт, вопроса никто не задавал.
 */
async function haltedRepeat(ctx: HaltContext, reason: HaltReason): Promise<InterviewStep> {
  const text = HALT_REPEAT_REPLY[reason];
  ctx.transcript.turns.push({ role: 'assistant', text, at: ctx.now().toISOString(), asking: null });

  await persist(ctx.db, ctx.row, {
    data: toJsonValue(parseDraft(ctx.row.data)),
    transcript: toJsonValue(ctx.transcript),
    status: ctx.row.status,
    completedAt: null,
  });

  log.info({ clientId: ctx.clientId, reason }, 'onboarding: message into a halted interview');
  return {
    kind: 'needs_human',
    text,
    missing: missingBriefFields(parseDraft(ctx.row.data)),
    askedCount: ctx.transcript.askedCount,
  };
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

function countAsks(transcript: InterviewTranscript, field: BriefField): number {
  return transcript.turns.filter((t) => t.role === 'assistant' && t.asking === field).length;
}

function formatFields(fields: readonly BriefField[]): string {
  if (fields.length === 0) return 'ничего — все обязательные поля собраны';
  return fields.map((field) => `- ${field}: ${BRIEF_FIELD_LABELS[field]}`).join('\n');
}
