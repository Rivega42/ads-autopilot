import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli } from './support/cli-process.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';

/**
 * Заведение клиента: единственный вход в систему для всего остального (ТЗ §9.1).
 *
 * До этой команды строку `Client` создавал только `prisma/seed.ts`, которого нет
 * в прод-образе; `ClientRepository.create` не вызывался ниоткуда, а бот клиентов
 * только ищет по `tgUserId`. Из-за этого заведение доступов (`credentials set`)
 * упиралось в «клиент должен существовать», и docs/RUNBOOK.md предлагал вместо
 * процедуры ручной `insert` в psql.
 *
 * Проверяется процессом и живой базой: команда без `--apply` не оставляет строки,
 * команда с `--apply` оставляет ровно одну и запись в журнале, а повтор того же
 * `tgUserId` не заводит второго и не переписывает первого.
 */

const TG_USER_ID = 880000001n;

describe('clients add', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('пустой список зовёт команду заведения, а не сид', async () => {
    const result = await runCli(['clients']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Клиентов нет');
    expect(result.stdout).toContain('clients add');
    // `pnpm db:seed` в прод-образе не существует — туда человека звать нельзя.
    expect(result.stdout).not.toContain('db:seed');
  });

  it('без --apply показывает, что будет заведено, и не пишет ни строки', async () => {
    const result = await runCli([
      'clients',
      'add',
      '--name',
      'ООО «Ромашка»',
      '--tg-user-id',
      String(TG_USER_ID),
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ООО «Ромашка»');
    expect(result.stdout).toContain(String(TG_USER_ID));
    expect(result.stdout).toContain('--apply');
    expect(await prisma.client.count()).toBe(0);
  });

  it('--apply заводит клиента, журнал и подсказывает следующий шаг', async () => {
    const result = await runCli([
      'clients',
      'add',
      '--name',
      'ООО «Ромашка»',
      '--tg-user-id',
      String(TG_USER_ID),
      '--apply',
    ]);

    expect(result.code).toBe(0);

    const client = await prisma.client.findUnique({ where: { tgUserId: TG_USER_ID } });
    expect(client).not.toBeNull();
    expect(client?.name).toBe('ООО «Ромашка»');
    expect(client?.status).toBe('ACTIVE');
    // Умолчания `id` и `updatedAt` живут в Prisma, а не в схеме БД: ручной insert
    // из runbook падал без них, а через репозиторий они проставляются сами.
    expect(client?.timezone).toBe('Europe/Moscow');
    expect(result.stdout).toContain(client?.id ?? 'нет id');

    const audit = await prisma.auditLog.findMany({ where: { action: 'client.create' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe('cli:clients');
    expect(audit[0]?.resource).toBe(`client:${client?.id}`);

    // Дальше по процедуре — доступы, и команда обязана назвать её сама.
    expect(result.stdout).toContain('credentials set');
    expect(result.stdout).toContain(`--client ${client?.id}`);
  });

  it('клиент виден в списке и опознаётся заведением доступов', async () => {
    const list = await runCli(['clients']);
    expect(list.stdout).toContain('ООО «Ромашка»');
    expect(list.stdout).toContain('нет доступов');

    const client = await prisma.client.findUnique({ where: { tgUserId: TG_USER_ID } });
    const creds = await runCli(['credentials', 'list', '--client', client?.id ?? '']);
    expect(creds.code).toBe(0);
    expect(creds.stdout).toContain('Доступов нет');
  });

  it('повтор того же tgUserId не заводит второго и не переписывает первого', async () => {
    const result = await runCli([
      'clients',
      'add',
      '--name',
      'Совсем другая контора',
      '--tg-user-id',
      String(TG_USER_ID),
      '--apply',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('уже заведён');
    expect(result.stderr).toContain('ООО «Ромашка»');

    expect(await prisma.client.count()).toBe(1);
    const client = await prisma.client.findUnique({ where: { tgUserId: TG_USER_ID } });
    expect(client?.name).toBe('ООО «Ромашка»');
  });

  it('статус берётся из --status и предупреждает про крон', async () => {
    const result = await runCli([
      'clients',
      'add',
      '--name',
      'Клиент на потом',
      '--tg-user-id',
      '880000002',
      '--status',
      'paused',
      '--apply',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PAUSED');
    expect(result.stdout).toContain('крон');
    const client = await prisma.client.findUnique({ where: { tgUserId: 880000002n } });
    expect(client?.status).toBe('PAUSED');
  });

  it('нечисловой tgUserId отвергается до записи', async () => {
    const before = await prisma.client.count();
    const result = await runCli([
      'clients',
      'add',
      '--name',
      'Кто-то',
      '--tg-user-id',
      '@romashka',
      '--apply',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('id Telegram');
    expect(await prisma.client.count()).toBe(before);
  });

  it('неизвестное действие названо вместе с известными', async () => {
    const result = await runCli(['clients', 'remove', '--client', 'x', '--apply']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('add');
  });

  it('заведение доступов больше не упирается в отсутствие клиента вслепую', async () => {
    // Сообщение «клиент не найден» обязано называть команду, которой его заводят:
    // раньше её не существовало, и человек уходил в psql.
    const result = await runCli(['credentials', 'list', '--client', 'нет-такого-клиента']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('clients add');
  });
});
