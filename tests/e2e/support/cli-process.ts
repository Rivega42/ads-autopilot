import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { CliMockDump } from './cli-apply-mocks.js';
import { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY } from './config.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const mockPreload = fileURLToPath(new URL('./cli-apply-mocks.ts', import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  /** Весь вывод: команда пишет объяснения в stdout, отказы — в stderr. */
  output: string;
  code: number;
}

export interface MockedCliResult extends CliResult {
  /** Что команда успела сказать площадкам: снято внутри её процесса. */
  mock: CliMockDump;
}

/** Токен бота для сценариев: он же зашит в мок, отвечающий вместо Telegram. */
export const E2E_BOT_TOKEN = '7000001:e2e-cli-bot-token';

/**
 * Запуск CLI настоящим процессом.
 *
 * Импортом нельзя: `src/apps/cli.ts` — точка входа, он вызывает `main()` прямо
 * на импорте. Подмен здесь нет вовсе (msw живёт в другом процессе), поэтому так
 * проверяются только пути, которые никуда не ходят: без `--apply` команда читает
 * базу и печатает. Путь записи запускается через `runCliWithCabinets`.
 */
export async function runCli(
  args: readonly string[],
  envOver: Record<string, string> = {},
): Promise<CliResult> {
  return exec(args, envOver, []);
}

/**
 * Тот же процесс, но с поднятыми внутри него моками Директа и Telegram.
 *
 * Моки поднимает `cli-apply-mocks.ts`, подгруженный до точки входа: перехват
 * обязан работать в том процессе, который ходит в сеть. На выходе он оставляет
 * файл со всем, что ушло площадкам, — это и есть единственный способ проверить
 * последствия команды, а не её код возврата.
 *
 * @param opts.fail - сервис Директа, который обязан отказать (`keywordbids`).
 * @param opts.blockChat - чат, где бота заблокировали: Telegram ответит 403.
 */
export async function runCliWithCabinets(
  args: readonly string[],
  envOver: Record<string, string> = {},
  opts: { fail?: string; blockChat?: string } = {},
): Promise<MockedCliResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ads-cli-e2e-'));
  const dumpPath = join(dir, 'platform.json');

  const result = await exec(
    args,
    {
      TELEGRAM_BOT_TOKEN: E2E_BOT_TOKEN,
      E2E_CLI_MOCK_DUMP: dumpPath,
      ...(opts.fail === undefined ? {} : { E2E_CLI_MOCK_FAIL: opts.fail }),
      ...(opts.blockChat === undefined ? {} : { E2E_CLI_MOCK_BLOCK_CHAT: opts.blockChat }),
      ...envOver,
    },
    ['--import', mockPreload],
  );

  let raw: string;
  try {
    raw = await readFile(dumpPath, 'utf8');
  } catch {
    throw new Error(`команда не оставила снимка площадок (${dumpPath}). Вывод:\n${result.output}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { ...result, mock: JSON.parse(raw) as CliMockDump };
}

async function exec(
  args: readonly string[],
  envOver: Record<string, string>,
  nodeArgs: readonly string[],
): Promise<CliResult> {
  const env = {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    CREDENTIALS_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    DRY_RUN: 'true',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...envOver,
  };

  try {
    // `--import tsx` вместо бинарника tsx: только так к загрузке TypeScript
    // добавляется ещё один модуль — моки площадок.
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', ...nodeArgs, 'src/apps/cli.ts', ...args],
      { cwd: repoRoot, env },
    );
    return { stdout, stderr, output: `${stdout}\n${stderr}`, code: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; code?: number };
    const stdout = failure.stdout ?? '';
    const stderr = failure.stderr ?? '';
    return { stdout, stderr, output: `${stdout}\n${stderr}`, code: failure.code ?? 1 };
  }
}
