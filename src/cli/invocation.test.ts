import { describe, expect, it } from 'vitest';

import { cliInvocation, DEV_INVOCATION, IMAGE_INVOCATION } from './invocation.js';

describe('cliInvocation', () => {
  it('в дереве исходников команда действительно зовётся pnpm cli', () => {
    expect(cliInvocation('/home/user/ads-autopilot/src/apps/cli.ts')).toBe(DEV_INVOCATION);
  });

  it('в собранном образе печатает роль cli: pnpm и tsx туда не кладут', () => {
    expect(cliInvocation('/app/dist/apps/cli.js')).toBe(IMAGE_INVOCATION);
  });

  it('dist в чужом каталоге считается тем же собранным входом', () => {
    expect(cliInvocation('/srv/ads/dist/apps/cli.js')).toBe(IMAGE_INVOCATION);
  });

  it('слово dist внутри имени файла собранным входом не делает', () => {
    expect(cliInvocation('/home/user/ads-autopilot/src/apps/dist-cli.ts')).toBe(DEV_INVOCATION);
  });

  it('незнакомая точка входа (vitest, ts-node) не выдаётся за прод', () => {
    // Прод-образ запускает ровно один файл — dist/apps/cli.js. Всё остальное
    // выполняется у разработчика, и подсказка про compose там сбивала бы с толку.
    expect(cliInvocation('/repo/node_modules/vitest/vitest.mjs')).toBe(DEV_INVOCATION);
    expect(cliInvocation(undefined)).toBe(DEV_INVOCATION);
  });

  it('склеивает подсказку с командой', () => {
    expect(`${cliInvocation('/app/dist/apps/cli.js')} clients`).toContain('ROLE=cli api clients');
  });
});
