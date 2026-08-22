import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli, type CliResult } from './support/cli-process.js';
import { resetDatabase } from './support/database.js';
import { seedAccount, type Fixture } from './support/seed.js';

import { prisma } from '@/db/prisma.js';

/**
 * Печатающий путь оптимизатора: пункт приёмки ТЗ §9.3 звучит буквально —
 * «оптимизатор в ручном режиме (`--dry-run`) показывает список рекомендаций».
 *
 * До этого сценария проверено было решение, а не показ: `optimization-cycle.e2e.ts`
 * сверяет, что цикл принимает и применяет решения, но ни одна строка вывода CLI
 * не сверялась ни с чем — команду не запускал ни один тест. А флага `--dry-run`
 * не существовало вовсе: `pnpm cli optimize --dry-run` падал с
 * `TypeError: Unknown option`.
 *
 * Живая здесь только наша БД. Наружу не уходит ничего и уйти не может: показ
 * читает базу и печатает, а единственный прогон с `--apply` сделан по клиенту,
 * у которого нет ни одной подходящей кампании.
 */

function textOf(result: CliResult): string {
  return result.output;
}

describe('optimize на пустой базе', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  it('отправляет за данными, а не молчит и не падает', async () => {
    const result = await runCli(['optimize', '--dry-run']);
    expect(result.code).toBe(0);
    expect(textOf(result)).toContain('Кампаний нет');
    expect(textOf(result)).toContain('ingest');
  });

  it('подсказка зовёт команду так, как её действительно зовут здесь', async () => {
    // В прод-образе нет ни pnpm, ни tsx, ни исходников (docs/DEPLOY.md §6.1), и
    // справка с `pnpm cli` врала ровно тому, кто читал её на сервере. Здесь
    // запущен `src/apps/cli.ts`, значит `pnpm cli` — правда.
    const result = await runCli(['--help']);
    expect(result.stdout).toContain('Использование: pnpm cli <команда>');
    expect(result.stdout).toContain('--dry-run');
  });
});

describe('optimize --dry-run показывает список рекомендаций', () => {
  let fx: Fixture;
  let result: CliResult;

  beforeAll(async () => {
    await resetDatabase();
    fx = await seedAccount();
    result = await runCli(['optimize', '--dry-run']);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('команда существует и завершается нулём (пункт приёмки ТЗ §9.3)', () => {
    expect(result.code).toBe(0);
    expect(textOf(result)).not.toContain('Unknown option');
  });

  it('называет кампанию, сущность и причину — а не только код действия', () => {
    const text = textOf(result);
    expect(text).toContain('Поиск — Слоны');
    expect(text).toContain('РСЯ — импорт из кабинета');
    // Пауза убыточной фразы: без имени фразы в строке человек видит cuid.
    expect(text).toContain('слон в посудной лавке купить');
    expect(text).toContain('PAUSE');
    expect(text).toContain('BID_DECREASE');
    // Причина — целое предложение с числами, оно же уезжает в карточку апрува.
    expect(text).toMatch(/CPA \d+\.\d+ \(\d/);
  });

  it('решения импортированной кампании показаны как заявки на апрув', () => {
    // Режим OBSERVER: всё уходит человеку, ничего не применяется само.
    expect(textOf(result)).toContain('[апрув');
  });

  it('отклонённое предохранителем печатается с названием рельса и объяснением', () => {
    const text = textOf(result);
    expect(text).toContain('MIN_OBSERVATIONS');
    // Свежая фраза с данными за сутки — та самая, которую предохранитель снимает.
    expect(text).toContain('слоны оптом со склада');
    expect(text).toContain('[отклонено');
  });

  it('итог назван числом и словами «ничего не применено»', () => {
    const text = textOf(result);
    expect(text).toMatch(/Всего решений: [1-9]/);
    expect(text).toContain('ничего не применено');
  });

  it('цель по CPA доезжает из брифа — иначе показ молчал бы про импорт', async () => {
    // У кампаний фикстуры своего `targetCpa` нет: он живёт в брифе клиента.
    // Пока показ не читал бриф, три правила из четырёх не срабатывали вовсе, и
    // «рекомендаций нет» читалось как «всё в пределах целей».
    const campaigns = await prisma.campaign.findMany({ select: { targetCpa: true } });
    expect(campaigns.every((c) => c.targetCpa === null)).toBe(true);
    expect(textOf(result)).not.toContain('Рекомендаций нет');
    expect(textOf(result)).not.toContain('Без цели по CPA');
  });

  it('минус-слово предложено по агрегату кампании — тому же, что видит крон', () => {
    expect(textOf(result)).toContain('ADD_NEGATIVE_KEYWORD');
    expect(textOf(result)).toContain('слон бесплатно скачать обои');
  });

  it('показ не пишет ничего: ни изменений, ни карточек, ни ключей', async () => {
    const [changes, approvals, keys] = await Promise.all([
      prisma.changeLog.count(),
      prisma.pendingApproval.count(),
      prisma.idempotencyKey.count(),
    ]);
    expect({ changes, approvals, keys }).toEqual({ changes: 0, approvals: 0, keys: 0 });
  });

  it('--client сужает вывод до одного клиента', async () => {
    const other = await runCli(['optimize', '--dry-run', '--client', 'нет-такого-клиента']);
    expect(other.code).toBe(0);
    expect(textOf(other)).toContain('Кампаний нет');
    expect(fx.clientId).toBeTruthy();
  });

  it('без флага печатает то же самое: dry-run остаётся умолчанием', async () => {
    const plain = await runCli(['optimize']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(result.stdout);
  });
});

describe('optimize: флаги про запись', () => {
  beforeAll(async () => {
    await resetDatabase();
    await seedAccount();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('--apply --dry-run отвергается: два флага про одно и то же', async () => {
    const result = await runCli(['optimize', '--apply', '--dry-run']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--apply');
    expect(result.stderr).toContain('--dry-run');
    // Молчаливый выбор одного из двух был бы хуже отказа: человек не знал бы,
    // тратятся сейчас деньги клиента или нет.
    expect(result.stdout).not.toContain('Изменений записано');
  });

  it('DRY_RUN=true в окружении старше флага и говорит об этом', async () => {
    const result = await runCli(['optimize', '--apply'], { DRY_RUN: 'true' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--apply проигнорирован');
    expect(result.stdout).toContain('DRY_RUN');
    expect(await prisma.changeLog.count()).toBe(0);
  });

  it('--apply уходит в ту же точку, что и крон, и печатает, что записано', async () => {
    // Клиент на паузе: `runScheduledOptimization` не берёт его кампании вовсе,
    // поэтому путь применения выполняется целиком, а наружу не уходит ни одного
    // запроса. Проверяется здесь именно проводка — раньше `--apply` не звал её
    // вообще и печатал число решений так, будто они применены.
    const paused = await prisma.client.create({
      data: { tgUserId: 771000009n, name: 'Клиент на паузе', status: 'PAUSED' },
    });
    const result = await runCli(['optimize', '--apply', '--client', paused.id], {
      DRY_RUN: 'false',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Кампаний просмотрено: 0');
    expect(result.stdout).toContain('Изменений записано в кабинеты: 0');
    expect(result.stdout).toContain('Карточек апрува выпущено: 0');
    expect(await prisma.changeLog.count()).toBe(0);
  });

  it('опечатка во флаге объясняется справкой, а не голым TypeError', async () => {
    const result = await runCli(['optimize', '--dryrun']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Команды:');
    expect(result.output).toContain('--dry-run');
  });
});
