import {
  DIRECT_LIMITS,
  validateCallout,
  validateDisplayLink,
  validateKeyword,
  validateSitelink,
  validateText,
  validateTitle,
  validateTitle2,
  warnLongTitle,
  type LimitViolation,
  type LimitWarning,
} from './limits.js';
import type { AccountBlueprint } from './types.js';

export interface ValidationResult {
  readonly violations: LimitViolation[];
  readonly warnings: LimitWarning[];
}

function normalizeKeyword(keyword: string): string {
  return keyword
    .replace(/["!+[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function validateAccount(account: AccountBlueprint): ValidationResult {
  const violations: LimitViolation[] = [];
  const warnings: LimitWarning[] = [];

  account.sitelinks.forEach((link, i) => {
    validateSitelink(`sitelinks[${i}]`, link.title, link.description, violations);
  });
  if (account.sitelinks.length > DIRECT_LIMITS.sitelinksMax) {
    violations.push({
      path: 'sitelinks',
      rule: 'sitelinksMax',
      actual: account.sitelinks.length,
      max: DIRECT_LIMITS.sitelinksMax,
      value: '',
    });
  }

  account.callouts.forEach((callout, i) => {
    validateCallout(`callouts[${i}]`, callout, violations);
  });

  for (const campaign of account.campaigns) {
    const path = `campaign "${campaign.name}"`;

    if (campaign.groups.length > DIRECT_LIMITS.groupsPerCampaign) {
      violations.push({
        path,
        rule: 'groupsPerCampaign',
        actual: campaign.groups.length,
        max: DIRECT_LIMITS.groupsPerCampaign,
        value: '',
      });
    }

    const seenKeywords = new Map<string, string>();

    for (const group of campaign.groups) {
      const gPath = `${path} / group "${group.name}"`;

      if (group.keywords.length > DIRECT_LIMITS.keywordsPerGroup) {
        violations.push({
          path: gPath,
          rule: 'keywordsPerGroup',
          actual: group.keywords.length,
          max: DIRECT_LIMITS.keywordsPerGroup,
          value: '',
        });
      }

      group.keywords.forEach((keyword, i) => {
        validateKeyword(`${gPath} / keyword[${i}]`, keyword, violations);

        // Одна и та же фраза в двух группах одной кампании — это конкуренция
        // групп между собой: Директ выберет одну, вторая копит нулевую статистику.
        const normalized = normalizeKeyword(keyword);
        const owner = seenKeywords.get(normalized);
        if (owner !== undefined && owner !== group.name) {
          violations.push({
            path: `${gPath} / keyword[${i}]`,
            rule: 'duplicateKeywordAcrossGroups',
            actual: 2,
            max: 1,
            value: `${keyword} (уже в группе "${owner}")`,
          });
        }
        seenKeywords.set(normalized, group.name);
      });

      const { ad } = group;

      if (ad.titles.length > DIRECT_LIMITS.combinatorialTitles) {
        violations.push({
          path: `${gPath} / ad.titles`,
          rule: 'combinatorialTitles',
          actual: ad.titles.length,
          max: DIRECT_LIMITS.combinatorialTitles,
          value: '',
        });
      }
      if (ad.texts.length > DIRECT_LIMITS.combinatorialTexts) {
        violations.push({
          path: `${gPath} / ad.texts`,
          rule: 'combinatorialTexts',
          actual: ad.texts.length,
          max: DIRECT_LIMITS.combinatorialTexts,
          value: '',
        });
      }

      ad.titles.forEach((title, i) => {
        validateTitle(`${gPath} / ad.titles[${i}]`, title, violations);
        warnLongTitle(`${gPath} / ad.titles[${i}]`, title, warnings);
      });
      ad.title2s.forEach((title2, i) => {
        validateTitle2(`${gPath} / ad.title2s[${i}]`, title2, violations);
      });
      ad.texts.forEach((text, i) => {
        validateText(`${gPath} / ad.texts[${i}]`, text, violations);
      });
      validateDisplayLink(`${gPath} / ad.displayLink`, ad.displayLink, violations);
    }
  }

  return { violations, warnings };
}

export function formatViolations(violations: readonly LimitViolation[]): string {
  return violations
    .map((v) => `${v.path}: ${v.rule} — ${v.actual}/${v.max} — «${v.value}»`)
    .join('\n');
}
