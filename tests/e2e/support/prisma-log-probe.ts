import { prisma } from '@/db/prisma.js';
import { createPrismaIdempotencyStore } from '@/optimizer/runtime.js';

/**
 * Что процесс печатает человеку, когда Prisma отвечает отказом.
 *
 * Отдельный процесс, а не проверка внутри сценария: Prisma при `emit: 'stdout'`
 * печатает дамп сама, через `console.error`, и момент этой печати не совпадает с
 * моментом, когда отвергается промис. Внутри vitest перехват такого вывода зависит
 * от того, успел ли раннер слить свой буфер, — то есть проверка была бы то зелёной,
 * то красной без единой правки кода. Дочерний процесс отвечает на вопрос целиком:
 * весь его stdout и stderr известны после выхода.
 *
 * Два режима — обе половины требования. `duplicate`: штатный дубль ключа
 * идемпотентности, человек не должен увидеть ничего. `unexpected`: тот же отказ
 * Postgres, но у вызывающего, который его не ждёт, — такое обязано быть видно.
 */
const MODE = process.argv[2];
const KEY = `probe:${process.argv[3] ?? 'x'}`;

async function duplicate(): Promise<void> {
  const store = createPrismaIdempotencyStore();
  const first = await store.reserve(KEY);
  const second = await store.reserve(KEY);
  if (first !== 'reserved' || second !== 'duplicate') {
    throw new Error(`ожидалось reserved/duplicate, получено ${first}/${second}`);
  }
}

async function unexpected(): Promise<void> {
  const data = {
    key: KEY,
    scope: 'probe',
    entityType: '',
    entityId: '',
    expiresAt: new Date(Date.now() + 60_000),
  };
  await prisma.idempotencyKey.create({ data });
  try {
    await prisma.idempotencyKey.create({ data });
    throw new Error('второй create обязан был упасть');
  } catch {
    // Ошибка ожидается сценарием; проверяется не она, а то, что о ней сказали в лог.
  }
}

try {
  if (MODE === 'duplicate') await duplicate();
  else if (MODE === 'unexpected') await unexpected();
  else throw new Error(`неизвестный режим ${String(MODE)}`);
  await prisma.idempotencyKey.deleteMany({ where: { key: KEY } });
} finally {
  await prisma.$disconnect();
}
