import { ApprovalKind, Provider, type Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * Описание операции, которую оптимизатор (или любой другой агент) хочет выполнить.
 *
 * Почему zod, а не просто TS-интерфейсы: дескриптор кладётся в `PendingApproval.payload`
 * как Json и достаётся оттуда через час-другой другим процессом. Между записью и
 * чтением схема кода может уехать, поэтому на входе в apply payload обязан пройти
 * валидацию — иначе мы применим в кабинет клиента непонятно что.
 */

const statLevelSchema = z.enum(['campaign', 'adgroup', 'ad', 'keyword']);

/** Поля, общие для всех действий. `reason` — объяснение оптимизатора, оно уходит в карточку. */
const baseAction = {
  clientId: z.string().min(1),
  channel: z.nativeEnum(Provider),
  reason: z.string().min(1),
};

export const createCampaignActionSchema = z.object({
  ...baseAction,
  kind: z.literal('create_campaign'),
  campaignName: z.string().min(1),
  dailyBudget: z.number().nonnegative(),
  strategy: z.record(z.unknown()).default({}),
});

export const budgetChangeActionSchema = z.object({
  ...baseAction,
  kind: z.literal('budget_change'),
  campaignExternalId: z.string().min(1),
  campaignName: z.string().min(1),
  /** Дневной бюджет до и после, в валюте кабинета. */
  before: z.number().nonnegative(),
  after: z.number().nonnegative(),
});

export const pauseEntitiesActionSchema = z.object({
  ...baseAction,
  kind: z.literal('pause_entities'),
  level: statLevelSchema,
  externalIds: z.array(z.string().min(1)).min(1),
});

export const resumeEntitiesActionSchema = z.object({
  ...baseAction,
  kind: z.literal('resume_entities'),
  level: statLevelSchema,
  externalIds: z.array(z.string().min(1)).min(1),
});

export const bidChangeActionSchema = z.object({
  ...baseAction,
  kind: z.literal('bid_change'),
  changes: z
    .array(
      z.object({
        keywordExternalId: z.string().min(1),
        bid: z.number().nonnegative(),
        /** Ставка до изменения — нужна только для ChangeLog, адаптеру не передаётся. */
        bidBefore: z.number().nonnegative().optional(),
      }),
    )
    .min(1),
});

export const addNegativesActionSchema = z.object({
  ...baseAction,
  kind: z.literal('add_negatives'),
  campaignExternalId: z.string().min(1),
  phrases: z.array(z.string().min(1)).min(1),
});

/**
 * Виды действий, которые система умеет довести до кабинета.
 *
 * Список закрыт исполнимостью, а не пожеланиями ТЗ. TZ §3.5 называет апрувом ещё
 * смену стратегии кампании и заливку LLM-креативов; здесь их нет намеренно.
 * `ChannelAdapter` не описывает ни ту, ни другую операцию, исполнителя у них тоже
 * не было — заявка такого вида доходила до человека, а на нажатие ✅ отвечала
 * «действие не поддерживается». Обещание в публичной схеме, которое ломается уже
 * после согласия человека, хуже отсутствующей функции: её хотя бы видно в
 * `docs/READINESS.md`. Появится исполнитель — член союза вернётся вместе с ним,
 * и `src/approval/execute.test.ts` не даст вернуть его отдельно.
 *
 * Заливка креативов сегодня доезжает до кабинета единственным путём — вместе с
 * планом новой кампании, а тот уже стоит за апрувом `create_campaign`.
 */
export const approvalActionSchema = z.discriminatedUnion('kind', [
  createCampaignActionSchema,
  budgetChangeActionSchema,
  pauseEntitiesActionSchema,
  resumeEntitiesActionSchema,
  bidChangeActionSchema,
  addNegativesActionSchema,
]);

export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export type ApprovalActionKind = ApprovalAction['kind'];
export type ApprovalActionInput = z.input<typeof approvalActionSchema>;

export type BudgetChangeAction = z.infer<typeof budgetChangeActionSchema>;
export type PauseEntitiesAction = z.infer<typeof pauseEntitiesActionSchema>;

/** Нормализует произвольный вход в дескриптор (проставляет дефолты, режет лишнее). */
export function parseAction(input: unknown): ApprovalAction {
  return approvalActionSchema.parse(input);
}

/**
 * Вид заявки для колонки `PendingApproval.kind`.
 *
 * У возобновления и минус-слов своего члена в `ApprovalKind` нет, поэтому они едут
 * на ближайшем по смыслу — так же, как ставки в `src/optimizer/policy.ts`.
 * Авторитетный вид действия всегда лежит в `payload.kind`; колонка нужна для выборок.
 */
const APPROVAL_KIND_BY_ACTION: Record<ApprovalActionKind, ApprovalKind> = {
  create_campaign: ApprovalKind.NEW_CAMPAIGN,
  budget_change: ApprovalKind.BUDGET_CHANGE,
  pause_entities: ApprovalKind.MASS_PAUSE,
  resume_entities: ApprovalKind.MASS_PAUSE,
  bid_change: ApprovalKind.BID_CHANGE,
  add_negatives: ApprovalKind.STRATEGY_CHANGE,
};

export function approvalKindOf(action: ApprovalAction): ApprovalKind {
  return APPROVAL_KIND_BY_ACTION[action.kind];
}

/**
 * Метаданные заявки: не часть действия, но нужны при применении.
 *
 * Живут в том же Json-поле `payload`, отдельной колонки под них нет. Это безопасно:
 * `approvalActionSchema` — обычный (не strict) объект, лишний ключ `meta` он срезает,
 * поэтому старые строки без метаданных читаются ровно как раньше.
 */
export const approvalMetaSchema = z.object({
  /**
   * Эффективный dry-run, вычисленный в момент отрисовки карточки. Человек принимает
   * решение по тексту карточки, а он рисуется именно из этого значения — значит и
   * применять надо с ним, а не с флагом, каким он станет через APPROVAL_TTL_MINUTES.
   */
  dryRun: z.boolean(),
});

export type ApprovalMeta = z.infer<typeof approvalMetaSchema>;

const payloadEnvelopeSchema = z.object({ meta: approvalMetaSchema.partial() });

/** Payload для колонки: действие целиком + метаданные исполнения. */
export function buildApprovalPayload(
  action: ApprovalAction,
  meta: ApprovalMeta,
): Prisma.InputJsonValue {
  return toJson({ ...action, meta });
}

/** Пустой объект — заявка создана старой версией кода, метаданных в ней нет. */
export function readApprovalMeta(payload: unknown): Partial<ApprovalMeta> {
  const parsed = payloadEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data.meta : {};
}

/**
 * Приведение к Prisma Json.
 *
 * `Record<string, unknown>` внутри стратегий несовместим с `InputJsonValue` по типам,
 * а через JSON-раунд-трип мы заодно получаем ровно то, что реально ляжет в колонку,
 * — без Date, undefined и прочего, что Prisma молча съест или отвергнет.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
