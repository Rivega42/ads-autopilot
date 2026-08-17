/**
 * Генератор файлов для загрузки аккаунта в Яндекс Директ.
 *
 * Запуск: pnpm tsx src/campaigns/smartsay/export.ts
 * Результат: docs/campaigns/smartsay/export/
 *
 * Основной рабочий формат — TSV: его можно вставить прямо в таблицу
 * Директ Коммандера или в выгруженный из Директа XLS-шаблон,
 * не подгоняя порядок колонок вручную.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adVariants } from './ad-variants.js';
import { SMARTSAY_ACCOUNT, UTM_TEMPLATE } from './blueprint.js';
import { CALLOUTS, SITELINKS } from './extensions.js';
import type { AdGroupBlueprint, CampaignBlueprint } from './types.js';
import { formatViolations, validateAccount } from './validate.js';

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/campaigns/smartsay/export',
);

const AD_COLUMNS = [
  'Название кампании',
  'Название группы',
  'Фраза (с минус-словами)',
  'Заголовок',
  'Заголовок 2',
  'Текст',
  'Ссылка',
  'Отображаемая ссылка',
  'Регионы показа',
  'Минус-фразы на группу',
  'Заголовки быстрых ссылок',
  'Описания быстрых ссылок',
  'Адреса быстрых ссылок',
  'Уточнения',
] as const;

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** Латиница в именах файлов: Директ Коммандер живёт на Windows. */
function slug(value: string): string {
  return [...value.toLowerCase()]
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

function landingUrl(group: AdGroupBlueprint): string {
  const separator = group.ad.landingPath.includes('?') ? '&' : '?';
  return `${SMARTSAY_ACCOUNT.site}${group.ad.landingPath}${separator}${UTM_TEMPLATE}`;
}

function tsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map((cell) => cell.replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
}

function write(relativePath: string, content: string): void {
  const target = join(OUT_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${content.trimEnd()}\n`, 'utf8');
}

function campaignRows(campaign: CampaignBlueprint): string[][] {
  const rows: string[][] = [];

  for (const group of campaign.groups) {
    const ads = adVariants(group);
    const url = landingUrl(group);
    const rowCount = Math.max(group.keywords.length, ads.length);

    for (let i = 0; i < rowCount; i += 1) {
      const ad = ads[i];
      const isFirstRow = i === 0;

      rows.push([
        isFirstRow ? campaign.name : '',
        isFirstRow ? group.name : '',
        group.keywords[i] ?? '',
        ad?.title ?? '',
        ad?.title2 ?? '',
        ad?.text ?? '',
        ad ? url : '',
        ad ? group.ad.displayLink : '',
        isFirstRow ? campaign.regions.join(', ') : '',
        isFirstRow ? group.negativeKeywords.join(', ') : '',
        ad ? SITELINKS.map((s) => s.title).join(' | ') : '',
        ad ? SITELINKS.map((s) => s.description).join(' | ') : '',
        ad ? SITELINKS.map((s) => s.url).join(' | ') : '',
        ad ? CALLOUTS.join(' | ') : '',
      ]);
    }
  }

  return rows;
}

function structureMarkdown(): string {
  const lines: string[] = [
    '# Структура аккаунта SmartSay в Яндекс Директе',
    '',
    '> Файл сгенерирован из `src/campaigns/smartsay/blueprint.ts`.',
    '> Не редактируй руками — правь blueprint и запускай `pnpm campaign:smartsay`.',
    '',
    '| # | Кампания | Площадка | Стратегия | Бюджет/нед | Групп | Фраз | Приоритет |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- |',
  ];

  SMARTSAY_ACCOUNT.campaigns.forEach((campaign, i) => {
    const keywords = campaign.groups.reduce((sum, g) => sum + g.keywords.length, 0);
    const status = campaign.startPaused === true ? 'пауза' : `${campaign.priority}`;
    lines.push(
      `| ${i + 1} | ${campaign.name} | ${campaign.placement} | ${campaign.strategy} | ` +
        `${campaign.weeklyBudgetRub.toLocaleString('ru-RU')} ₽ | ${campaign.groups.length} | ${keywords} | ${status} |`,
    );
  });

  for (const campaign of SMARTSAY_ACCOUNT.campaigns) {
    lines.push('', `## ${campaign.name}`, '', campaign.note, '');
    lines.push(`**Регионы:** ${campaign.regions.join(', ')}`, '');

    const modifiers = campaign.bidModifiers ?? [];
    if (modifiers.length > 0) {
      lines.push('**Корректировки ставок:**', '');
      for (const modifier of modifiers) {
        const target =
          modifier.kind === 'region'
            ? `регион «${modifier.region}»`
            : modifier.kind === 'age'
              ? `возраст ${modifier.age}`
              : 'мобильные';
        const shift = modifier.percent === 0 ? 'не показывать' : `${modifier.percent - 100}%`;
        lines.push(`- ${target}: ${shift} — ${modifier.note}`);
      }
      lines.push('');
    }

    for (const group of campaign.groups) {
      lines.push(`### ${group.name}`, '');
      if (group.note !== undefined) lines.push(`> ${group.note}`, '');
      lines.push(`**Посадочная:** \`${group.ad.landingPath}\``, '');

      if (group.keywords.length > 0) {
        lines.push('**Ключевые фразы:**', '');
        lines.push(...group.keywords.map((k) => `- ${k}`));
        lines.push('');
      }
      if (group.negativeKeywords.length > 0) {
        lines.push(`**Минус-фразы группы:** ${group.negativeKeywords.join(', ')}`, '');
      }

      lines.push('**Заголовки:**', '');
      lines.push(...group.ad.titles.map((t) => `- ${t} _(${[...t].length})_`));
      lines.push('', '**Вторые заголовки:**', '');
      lines.push(...group.ad.title2s.map((t) => `- ${t} _(${[...t].length})_`));
      lines.push('', '**Тексты:**', '');
      lines.push(...group.ad.texts.map((t) => `- ${t} _(${[...t].length})_`));
      lines.push('');
    }
  }

  return lines.join('\n');
}

function main(): void {
  const { violations, warnings } = validateAccount(SMARTSAY_ACCOUNT);
  if (violations.length > 0) {
    process.stderr.write(
      `Blueprint не проходит лимиты Директа:\n${formatViolations(violations)}\n`,
    );
    process.exit(1);
  }

  rmSync(OUT_DIR, { recursive: true, force: true });

  const allRows: string[][] = [];
  for (const campaign of SMARTSAY_ACCOUNT.campaigns) {
    const rows = campaignRows(campaign);
    allRows.push(...rows);
    write(`commander/${slug(campaign.name)}.tsv`, tsv([[...AD_COLUMNS], ...rows]));

    if (campaign.negativeKeywords.length > 0) {
      write(`negatives/campaign-${slug(campaign.name)}.txt`, campaign.negativeKeywords.join('\n'));
    }

    for (const group of campaign.groups) {
      if (group.keywords.length > 0) {
        write(
          `keywords/${slug(campaign.name)}__${slug(group.name)}.txt`,
          group.keywords.join('\n'),
        );
      }
    }
  }

  write('all-campaigns.tsv', tsv([[...AD_COLUMNS], ...allRows]));
  write('negatives/global.txt', SMARTSAY_ACCOUNT.globalNegativeKeywords.join('\n'));
  write('callouts.txt', CALLOUTS.join('\n'));
  write(
    'sitelinks.tsv',
    tsv([
      ['Заголовок', 'Описание', 'Ссылка'],
      ...SITELINKS.map((s) => [s.title, s.description, s.url]),
    ]),
  );
  write('utm-template.txt', UTM_TEMPLATE);
  write('../structure.md', structureMarkdown());

  const keywordTotal = SMARTSAY_ACCOUNT.campaigns.reduce(
    (sum, c) => sum + c.groups.reduce((s, g) => s + g.keywords.length, 0),
    0,
  );

  process.stdout.write(
    [
      `Кампаний: ${SMARTSAY_ACCOUNT.campaigns.length}`,
      `Групп: ${SMARTSAY_ACCOUNT.campaigns.reduce((s, c) => s + c.groups.length, 0)}`,
      `Ключевых фраз: ${keywordTotal}`,
      `Минус-слов в общем списке: ${SMARTSAY_ACCOUNT.globalNegativeKeywords.length}`,
      `Строк в all-campaigns.tsv: ${allRows.length}`,
      `Предупреждений о длинных заголовках: ${warnings.length}`,
      `Готово: ${OUT_DIR}`,
    ].join('\n'),
  );
}

main();
