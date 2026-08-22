import { describe, expect, it, vi } from 'vitest';

import { runClientsCommand, type ClientsCommandDeps, type NewClient } from './clients.js';

import type { AppError } from '@/lib/errors.js';

function collector() {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

function depsWith(over: Partial<ClientsCommandDeps> = {}): ClientsCommandDeps {
  return {
    list: () => Promise.resolve([]),
    findByTgUserId: () => Promise.resolve(null),
    create: (input: NewClient) =>
      Promise.resolve({ id: 'cl_new', name: input.name, status: input.status }),
    ...over,
  };
}

async function failure(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('ожидалась ошибка, команда завершилась успешно');
}

describe('clients (список)', () => {
  it('на пустой базе называет команду заведения, а не сид', async () => {
    const sink = collector();
    await runClientsCommand({ apply: false }, depsWith({ out: sink.out }));

    expect(sink.text()).toContain('Клиентов нет');
    // Сида в прод-образе нет вовсе, а «pnpm db:seed» отправлял человека туда,
    // куда он попасть не может.
    expect(sink.text()).toContain('clients add');
    expect(sink.text()).not.toContain('db:seed');
  });

  it('печатает клиента с каналами и числом кампаний', async () => {
    const sink = collector();
    await runClientsCommand(
      { apply: false },
      depsWith({
        out: sink.out,
        list: () =>
          Promise.resolve([
            {
              id: 'cl_1',
              name: 'ООО «Слонопотам»',
              status: 'ACTIVE',
              providers: ['YANDEX_DIRECT'],
              campaigns: 2,
            },
          ]),
      }),
    );

    const text = sink.text();
    expect(text).toContain('cl_1');
    expect(text).toContain('ООО «Слонопотам»');
    expect(text).toContain('ACTIVE');
    expect(text).toContain('YANDEX_DIRECT');
    expect(text).toContain('2');
  });
});

describe('clients add: проверки до записи', () => {
  it('неизвестное действие названо вместе со списком известных', async () => {
    const err = await failure(runClientsCommand({ action: 'delete', apply: true }, depsWith()));
    expect(err.code).toBe('CLIENT_ACTION_UNKNOWN');
    expect(err.message).toContain('add');
  });

  it('без имени не заводит: имя видит клиент в отчётах', async () => {
    const err = await failure(
      runClientsCommand({ action: 'add', tgUserId: '100500', apply: true }, depsWith()),
    );
    expect(err.code).toBe('CLIENT_NAME_MISSING');
    expect(err.message).toContain('--name');
  });

  it('имя из одних пробелов именем не считается', async () => {
    const err = await failure(
      runClientsCommand(
        { action: 'add', name: '   ', tgUserId: '100500', apply: true },
        depsWith(),
      ),
    );
    expect(err.code).toBe('CLIENT_NAME_MISSING');
  });

  it('без tgUserId не заводит: бот опознаёт клиента только по нему', async () => {
    const err = await failure(
      runClientsCommand({ action: 'add', name: 'Ромашка', apply: true }, depsWith()),
    );
    expect(err.code).toBe('CLIENT_TG_ID_MISSING');
    expect(err.message).toContain('--tg-user-id');
  });

  it('нечисловой tgUserId отвергается, а не превращается в NaN', async () => {
    const err = await failure(
      runClientsCommand(
        { action: 'add', name: 'Ромашка', tgUserId: '@romashka', apply: true },
        depsWith(),
      ),
    );
    expect(err.code).toBe('CLIENT_TG_ID_INVALID');
  });

  it('ноль и отрицательный id Telegram не выдаёт', async () => {
    for (const raw of ['0', '-5']) {
      const err = await failure(
        runClientsCommand(
          { action: 'add', name: 'Ромашка', tgUserId: raw, apply: true },
          depsWith(),
        ),
      );
      expect(err.code).toBe('CLIENT_TG_ID_INVALID');
    }
  });

  it('большой id не теряет точность по дороге через Number', async () => {
    const create = vi.fn((input: NewClient) =>
      Promise.resolve({ id: 'cl_big', name: input.name, status: input.status }),
    );
    await runClientsCommand(
      { action: 'add', name: 'Ромашка', tgUserId: '9007199254740993', apply: true },
      depsWith({ out: () => {}, create }),
    );
    expect(create.mock.calls[0]?.[0].tgUserId).toBe(9007199254740993n);
  });

  it('неизвестный статус отвергается со списком допустимых', async () => {
    const err = await failure(
      runClientsCommand(
        { action: 'add', name: 'Ромашка', tgUserId: '1', status: 'active!', apply: true },
        depsWith(),
      ),
    );
    expect(err.code).toBe('CLIENT_STATUS_UNKNOWN');
    expect(err.message).toContain('ACTIVE');
  });
});

describe('clients add: запись', () => {
  it('без --apply показывает, что будет заведено, и ничего не пишет', async () => {
    const sink = collector();
    const create = vi.fn();
    await runClientsCommand(
      { action: 'add', name: 'Ромашка', tgUserId: '100500', apply: false },
      depsWith({ out: sink.out, create }),
    );

    expect(create).not.toHaveBeenCalled();
    expect(sink.text()).toContain('Ромашка');
    expect(sink.text()).toContain('100500');
    expect(sink.text()).toContain('--apply');
  });

  it('с --apply заводит и подсказывает следующий шаг — доступы', async () => {
    const sink = collector();
    const create = vi.fn((input: NewClient) =>
      Promise.resolve({ id: 'cl_new', name: input.name, status: input.status }),
    );
    await runClientsCommand(
      { action: 'add', name: 'Ромашка', tgUserId: '100500', apply: true },
      depsWith({ out: sink.out, create }),
    );

    expect(create).toHaveBeenCalledWith({ tgUserId: 100500n, name: 'Ромашка', status: 'ACTIVE' });
    expect(sink.text()).toContain('cl_new');
    expect(sink.text()).toContain('credentials set');
  });

  it('статус берётся из --status и приводится к верхнему регистру', async () => {
    const sink = collector();
    const create = vi.fn((input: NewClient) =>
      Promise.resolve({ id: 'cl_p', name: input.name, status: input.status }),
    );
    await runClientsCommand(
      { action: 'add', name: 'Ромашка', tgUserId: '100500', status: 'paused', apply: true },
      depsWith({ out: sink.out, create }),
    );

    expect(create.mock.calls[0]?.[0].status).toBe('PAUSED');
    // Тот же предупреждающий текст, что у credentials: неактивного клиента крон
    // пропускает, и заведённый «впрок» клиент выглядит рабочим, ничего не делая.
    expect(sink.text()).toContain('PAUSED');
    expect(sink.text()).toContain('крон');
  });

  it('занятый tgUserId — отказ с именем занявшего, а не тихое обновление', async () => {
    const create = vi.fn();
    const err = await failure(
      runClientsCommand(
        { action: 'add', name: 'Новая Ромашка', tgUserId: '100500', apply: true },
        depsWith({
          out: () => {},
          create,
          findByTgUserId: () =>
            Promise.resolve({ id: 'cl_old', name: 'Старая Ромашка', status: 'ACTIVE' }),
        }),
      ),
    );

    expect(err.code).toBe('CLIENT_TG_ID_TAKEN');
    expect(err.message).toContain('cl_old');
    expect(err.message).toContain('Старая Ромашка');
    expect(create).not.toHaveBeenCalled();
  });

  it('занятый tgUserId виден и в черновом прогоне — иначе про него узнают только с --apply', async () => {
    const err = await failure(
      runClientsCommand(
        { action: 'add', name: 'Новая Ромашка', tgUserId: '100500', apply: false },
        depsWith({
          out: () => {},
          findByTgUserId: () =>
            Promise.resolve({ id: 'cl_old', name: 'Старая Ромашка', status: 'PAUSED' }),
        }),
      ),
    );
    expect(err.code).toBe('CLIENT_TG_ID_TAKEN');
  });
});
