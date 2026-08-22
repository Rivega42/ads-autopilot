import type { PrismaClient } from '@prisma/client';

import { prisma } from '@/db/prisma.js';
import { getReportMessenger, type ReportMessenger } from '@/reporter/telegram.js';

/**
 * Точки подмены модуля отчётов.
 *
 * Тот же приём, что в `src/ingestion/deps.ts`: наружу торчит один `resolveDeps`,
 * а юнит-тестам не нужны ни Postgres, ни токен бота. Хранилище сужено до пяти
 * моделей — отчётам нечего делать в остальной схеме, и заглушка в тесте
 * получается обозримой.
 */
export type ReporterDb = Pick<
  PrismaClient,
  'client' | 'campaign' | 'campaignStat' | 'report' | 'errorLog'
>;

export interface ReporterDeps {
  db: ReporterDb;
  /** Ленивый: разбор отчёта считается и сохраняется даже без настроенного бота. */
  messenger: () => ReportMessenger;
  now: () => Date;
}

export function resolveDeps(partial: Partial<ReporterDeps> = {}): ReporterDeps {
  return {
    db: partial.db ?? prisma,
    messenger: partial.messenger ?? getReportMessenger,
    now: partial.now ?? ((): Date => new Date()),
  };
}
