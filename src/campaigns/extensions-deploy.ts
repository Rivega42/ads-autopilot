import type { Transport } from '../clients/yandex-direct/deploy-types.js';

import type { Sitelink, VCard } from './smartsay/types.js';

/**
 * Расширения объявлений: быстрые ссылки, уточнения, визитка, картинки.
 *
 * Без них объявление занимает вдвое меньше места в выдаче и теряет CTR,
 * поэтому создаются они до объявлений, а не «когда-нибудь потом руками».
 */

interface AddResult {
  readonly AddResults: readonly { readonly Id?: number; readonly Errors?: unknown[] }[];
}

interface ImageAddResult {
  readonly AddResults: readonly {
    readonly AdImageHash?: string;
    readonly Errors?: unknown[];
  }[];
}

function firstId(result: AddResult, what: string): number {
  const item = result.AddResults[0];
  if (item?.Id === undefined) {
    throw new Error(`Директ не создал ${what}: ${JSON.stringify(item?.Errors ?? item)}`);
  }
  return item.Id;
}

/** Набор быстрых ссылок общий на весь аккаунт — Директ хранит его отдельно от кампаний. */
export async function createSitelinkSet(
  transport: Transport,
  sitelinks: readonly Sitelink[],
): Promise<number> {
  const result = await transport.request<AddResult>('sitelinks', 'add', {
    SitelinksSets: [
      {
        Sitelinks: sitelinks.map((link) => ({
          Title: link.title,
          Description: link.description,
          Href: link.url,
        })),
      },
    ],
  });
  return firstId(result, 'набор быстрых ссылок');
}

export async function createCallouts(
  transport: Transport,
  callouts: readonly string[],
): Promise<number[]> {
  const result = await transport.request<AddResult>('adextensions', 'add', {
    AdExtensions: callouts.map((text) => ({ Callout: { CalloutText: text } })),
  });
  return result.AddResults.map((item, i) => {
    if (item.Id === undefined) {
      throw new Error(`Директ не создал уточнение «${callouts[i]}»`);
    }
    return item.Id;
  });
}

const PHONE_PATTERN = /^\+(\d)\s*(\d{3})\s*(.+)$/;

/** Визитка привязана к конкретной кампании: у Директа это объект уровня кампании. */
export async function createVCard(
  transport: Transport,
  campaignId: number,
  vcard: VCard,
): Promise<number> {
  const match = PHONE_PATTERN.exec(vcard.phone);
  if (match === null) {
    throw new Error(`Телефон визитки не разобран: ${vcard.phone}`);
  }
  const [, countryCode, cityCode, rest] = match;

  const result = await transport.request<AddResult>('vcards', 'add', {
    VCards: [
      {
        CampaignId: campaignId,
        Country: 'Россия',
        City: vcard.city,
        CompanyName: vcard.company,
        WorkTime: '0#6#10#00#21#00',
        Phone: {
          CountryCode: `+${countryCode}`,
          CityCode: cityCode,
          PhoneNumber: (rest ?? '').replace(/\D/g, ''),
        },
        Street: vcard.street,
        House: '',
        ContactEmail: vcard.email,
      },
    ],
  });
  return firstId(result, `визитку кампании ${campaignId}`);
}

/** Картинки загружаются один раз на аккаунт и переиспользуются по хешу. */
export async function uploadImages(
  transport: Transport,
  images: readonly { readonly name: string; readonly base64: string }[],
): Promise<string[]> {
  if (images.length === 0) return [];

  const result = await transport.request<ImageAddResult>('adimages', 'add', {
    AdImages: images.map((image) => ({ Name: image.name, ImageData: image.base64 })),
  });

  return result.AddResults.map((item, i) => {
    if (item.AdImageHash === undefined) {
      throw new Error(`Директ не принял картинку «${images[i]?.name}»`);
    }
    return item.AdImageHash;
  });
}
