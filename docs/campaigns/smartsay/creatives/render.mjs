/**
 * Сборка креативов для РСЯ из creatives.html.
 *
 * Запуск: node docs/campaigns/smartsay/creatives/render.mjs
 * Правки вносим в разметку, картинки только пересобираются.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, 'out');

const executablePath = process.env.CHROMIUM_PATH;

const THEMES = ['adults', 'kids', 'preschool', 'online', 'brand'];
const RATIOS = ['1x1', '16x9', '3x4'];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
const page = await browser.newPage({ viewport: { width: 2100, height: 1200 } });
await page.goto(pathToFileURL(join(DIR, 'creatives.html')).href, { waitUntil: 'load' });

for (const theme of THEMES) {
  for (const ratio of RATIOS) {
    const id = `${theme}-${ratio}`;
    await page.locator(`#${id}`).screenshot({ path: join(OUT, `${id}.jpg`), quality: 88 });
    process.stdout.write(`${id}.jpg\n`);
  }
}

await browser.close();
