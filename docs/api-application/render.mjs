/**
 * Пересборка материалов заявки на доступ к API Директа.
 *
 * Запуск: node docs/api-application/render.mjs
 * Правки вносим в spec.html и mockups.html — картинки только пересобираются.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

const DIR = dirname(fileURLToPath(import.meta.url));

// Playwright ищет браузер сам; путь подменяем только если он задан в окружении.
const executablePath = process.env.CHROMIUM_PATH;

const SCREENS = {
  s1: 'mockups/ui-1-dashboard-campaigns.png',
  s2: 'mockups/ui-2-optimizer-log.png',
  s3: 'mockups/ui-3-telegram-approval.png',
  s4: 'mockups/ui-4-cli-deploy.png',
};

const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });

const specPage = await browser.newPage();
await specPage.goto(pathToFileURL(join(DIR, 'spec.html')).href, { waitUntil: 'load' });
await specPage.pdf({
  path: join(DIR, 'ads-autopilot-api-spec.pdf'),
  format: 'A4',
  printBackground: true,
});

const mockPage = await browser.newPage({
  viewport: { width: 1240, height: 900 },
  deviceScaleFactor: 2,
});
await mockPage.goto(pathToFileURL(join(DIR, 'mockups.html')).href, { waitUntil: 'load' });

for (const [id, file] of Object.entries(SCREENS)) {
  await mockPage.locator(`#${id}`).screenshot({ path: join(DIR, file) });
  process.stdout.write(`${file}\n`);
}

await browser.close();
process.stdout.write('ads-autopilot-api-spec.pdf\n');
