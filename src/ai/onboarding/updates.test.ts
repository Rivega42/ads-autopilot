import { describe, expect, it } from 'vitest';

import { interviewTurnSchema } from './turn.schema.js';
import {
  applyTurnUpdates,
  mentionsWebAddress,
  normalizeQuote,
  quoteFound,
  quoteMentionsNumber,
} from './updates.js';

const CLIENT_SAID = ['Курсы английского для айтишников', 'Готов платить 2000 ₽ за заявку'];

function turn(patch: Record<string, unknown>) {
  return interviewTurnSchema.parse({ reply: 'Дальше?', ...patch });
}

describe('normalizeQuote', () => {
  it('стирает пунктуацию и регистр', () => {
    expect(normalizeQuote('  2000 ₽, за Заявку!  ')).toBe('2000 за заявку');
  });
});

describe('quoteFound', () => {
  it('находит цитату с другой пунктуацией и регистром', () => {
    expect(quoteFound('2000 ₽!', ['Готов платить 2000 рублей за заявку'])).toBe(true);
  });

  it('не находит цифру, которой клиент не называл', () => {
    expect(quoteFound('3500 рублей', ['готов платить 2000 рублей'])).toBe(false);
  });

  it('не считает подтверждением односимвольную цитату', () => {
    expect(quoteFound('2', ['2000 рублей'])).toBe(false);
  });
});

describe('quoteMentionsNumber', () => {
  it('находит число, записанное с разделителями тысяч', () => {
    expect(quoteMentionsNumber('2 000 ₽', 2_000)).toBe(true);
    // Неразрывный пробел прилетает из копипасты — цитата от этого честнее не станет.
    expect(quoteMentionsNumber('2\u00a0000 ₽', 2_000)).toBe(true);
    expect(quoteMentionsNumber('счётчик 12.345.678', 12_345_678)).toBe(true);
    expect(quoteMentionsNumber('12 345 678', 12_345_678)).toBe(true);
  });

  it('понимает «тыщи» и «к», как их пишут клиенты', () => {
    expect(quoteMentionsNumber('5 тыщ в день', 5_000)).toBe(true);
    expect(quoteMentionsNumber('до 3 тысяч', 3_000)).toBe(true);
    expect(quoteMentionsNumber('по 2к за заявку', 2_000)).toBe(true);
    expect(quoteMentionsNumber('1 млн в месяц', 1_000_000)).toBe(true);
  });

  it('не находит числа, которого в цитате нет', () => {
    expect(quoteMentionsNumber('12345678', 44_001)).toBe(false);
    expect(quoteMentionsNumber('счётчик', 99_999_999)).toBe(false);
    expect(quoteMentionsNumber('2000 ₽', 3_000)).toBe(false);
  });

  it('не принимает часть числа за само число', () => {
    expect(quoteMentionsNumber('44001', 4_400)).toBe(false);
  });
});

describe('applyTurnUpdates', () => {
  it('принимает неденежные поля без цитат', () => {
    const result = applyTurnUpdates({}, turn({ updates: { product: 'Курсы английского' } }), []);
    expect(result.draft.product).toBe('Курсы английского');
    expect(result.rejected).toEqual([]);
  });

  it('принимает сумму, подтверждённую цитатой клиента', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { targetCpaRub: 2000 }, evidence: { targetCpaRub: '2000 ₽ за заявку' } }),
      CLIENT_SAID,
    );
    expect(result.draft.targetCpaRub).toBe(2_000);
    expect(result.accepted).toContain('targetCpaRub');
  });

  it('отбрасывает сумму без цитаты', () => {
    const result = applyTurnUpdates({}, turn({ updates: { targetCpaRub: 2000 } }), CLIENT_SAID);
    expect(result.draft.targetCpaRub).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'targetCpaRub', reason: 'no-evidence' });
  });

  it('отбрасывает сумму, которой клиент не называл', () => {
    // Модель «вывела» типичный для ниши CPA и сослалась на несуществующую фразу.
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { targetCpaRub: 3500 },
        evidence: { targetCpaRub: 'обычно в нише 3500' },
      }),
      CLIENT_SAID,
    );
    expect(result.draft.targetCpaRub).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ reason: 'evidence-not-found' });
  });

  it('отбрасывает счётчик Метрики без цитаты', () => {
    // Правдоподобный, но выдуманный номер — это чужие конверсии в отчёте клиента.
    const result = applyTurnUpdates(
      {},
      turn({ updates: { metrika: { counterId: 12_345_678 } } }),
      CLIENT_SAID,
    );
    expect(result.draft.metrika).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'metrika', reason: 'no-evidence' });
  });

  it('принимает счётчик, названный клиентом', () => {
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 12_345_678 } },
        evidence: { metrika: '12345678' },
      }),
      [...CLIENT_SAID, 'Счётчик 12345678'],
    );
    expect(result.draft.metrika).toEqual({ counterId: 12_345_678 });
  });

  it('отбрасывает счётчик, цитата для которого его не содержит', () => {
    // Клиент сказал «номер сейчас не помню» — слово «счётчик» в его ответе есть,
    // а номера нет: цитата обязана содержать само значение, иначе это не цитата.
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 99_999_999 } },
        evidence: { metrika: 'счётчик' },
      }),
      [...CLIENT_SAID, 'Счётчик номер сейчас не помню'],
    );
    expect(result.draft.metrika).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'metrika', reason: 'value-not-quoted' });
  });

  it('отбрасывает блок Метрики, если цитата подтверждает только счётчик', () => {
    // Цитата одна на весь объект, а цель — это то, что система считает заявкой:
    // по ней двигаются ставки, и её тоже должен был назвать клиент.
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 12_345_678, goalId: 44_001 } },
        evidence: { metrika: '12345678' },
      }),
      [...CLIENT_SAID, 'Счётчик 12345678, цель заявка с формы — 44001'],
    );
    expect(result.draft.metrika).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ reason: 'value-not-quoted' });
  });

  it('принимает счётчик с целью, когда цитата содержит оба числа', () => {
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 12_345_678, goalId: 44_001 } },
        evidence: { metrika: 'счётчик 12345678, цель заявка с формы — 44001' },
      }),
      [...CLIENT_SAID, 'Да, счётчик 12345678, цель заявка с формы — 44001'],
    );
    expect(result.draft.metrika).toEqual({ counterId: 12_345_678, goalId: 44_001 });
    expect(result.rejected).toEqual([]);
  });

  it('снимает id цели, который клиент не называл, но оставляет саму цель', () => {
    // Названия целей клиент диктует словами, и переспрашивать их из-за выдуманного
    // id — значит зациклить интервью на поле, на которое он уже ответил.
    const result = applyTurnUpdates(
      {},
      turn({ updates: { conversionGoals: [{ name: 'заявка', metrikaGoalId: 44_001 }] } }),
      CLIENT_SAID,
    );
    expect(result.draft.conversionGoals).toEqual([{ name: 'заявка' }]);
    expect(result.rejected[0]).toMatchObject({
      field: 'conversionGoals',
      reason: 'no-evidence',
      value: [44_001],
    });
  });

  it('оставляет id цели, названный клиентом', () => {
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { conversionGoals: [{ name: 'заявка', metrikaGoalId: 44_001 }] },
        evidence: { conversionGoals: 'цель заявка — 44001' },
      }),
      [...CLIENT_SAID, 'Цель заявка — 44001'],
    );
    expect(result.draft.conversionGoals).toEqual([{ name: 'заявка', metrikaGoalId: 44_001 }]);
    expect(result.rejected).toEqual([]);
  });

  it('цели без id цитаты не требуют', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { conversionGoals: [{ name: 'заявка с формы' }, { name: 'звонок' }] } }),
      CLIENT_SAID,
    );
    expect(result.draft.conversionGoals).toEqual([{ name: 'заявка с формы' }, { name: 'звонок' }]);
    expect(result.rejected).toEqual([]);
  });

  it('«Метрики нет» цитаты не требует', () => {
    // Отказ — не выдуманное значение: подтверждать в нём нечего.
    const result = applyTurnUpdates({}, turn({ updates: { metrika: null } }), CLIENT_SAID);
    expect(result.draft.metrika).toBeNull();
    expect(result.rejected).toEqual([]);
  });

  it('не роняет остальные поля хода из-за отклонённой суммы', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { geo: ['Москва'], dailyBudgetRub: 5000 } }),
      CLIENT_SAID,
    );
    expect(result.draft.geo).toEqual(['Москва']);
    expect(result.draft.dailyBudgetRub).toBeUndefined();
  });

  it('перезаписывает уже известное поле новым ответом', () => {
    const result = applyTurnUpdates(
      { geo: ['Москва'] },
      turn({ updates: { geo: ['Москва', 'Казань'] } }),
      [],
    );
    expect(result.draft.geo).toEqual(['Москва', 'Казань']);
  });

  /**
   * Ссылка стала обязательной (`REQUIRED_BRIEF_FIELDS`), и это подняло цену
   * выдумки: поле, без которого интервью не закончить, модель заполнить хочет.
   * Выдуманный адрес — это чужой сайт, на который клиент купит трафик.
   */
  it('принимает ссылку, названную клиентом без схемы', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { landingUrl: 'https://okna-spb.ru/lp' } }),
      [...CLIENT_SAID, 'сайт okna-spb.ru/lp'],
    );
    expect(result.draft.landingUrl).toBe('https://okna-spb.ru/lp');
    expect(result.accepted).toContain('landingUrl');
  });

  it('отбрасывает ссылку, которой в ответах клиента нет', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { landingUrl: 'https://it-english.ru' } }),
      CLIENT_SAID,
    );
    expect(result.draft.landingUrl).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'landingUrl', reason: 'url-not-mentioned' });
  });

  /**
   * Ложные отказы стоят дороже лишней строки в логе: третий отказ подряд говорит
   * клиенту с работающим сайтом, что кампанию в Директе завести не получится.
   * Поэтому там, где адрес назван, но записан не теми буквами, берётся тот, что
   * написал клиент, — а не отбрасывается всё.
   */
  it('принимает кириллический домен, записанный моделью в punycode', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { landingUrl: 'https://xn----7sbe7apelp.xn--p1ai/' } }),
      [...CLIENT_SAID, 'наш сайт окна-спб.рф'],
    );
    expect(result.draft.landingUrl).toBe('https://xn----7sbe7apelp.xn--p1ai/');
    expect(result.accepted).toContain('landingUrl');
  });

  it('оставляет от дописанного моделью пути только то, что назвал клиент', () => {
    // «okna-spb.ru» и «okna-spb.ru/akcii» ведут в разные места, и второе клиент
    // не называл: страница акции могла быть закрыта ещё в прошлом сезоне. Но и
    // отказывать нельзя — домен-то он назвал.
    const result = applyTurnUpdates(
      {},
      turn({ updates: { landingUrl: 'https://okna-spb.ru/akcii?utm_source=tg' } }),
      [...CLIENT_SAID, 'наш сайт okna-spb.ru'],
    );
    expect(result.draft.landingUrl).toBe('https://okna-spb.ru/');
    expect(result.accepted).toContain('landingUrl');
    expect(result.corrected).toEqual([
      {
        field: 'landingUrl',
        value: 'https://okna-spb.ru/akcii?utm_source=tg',
        used: 'https://okna-spb.ru/',
      },
    ]);
  });

  it('берёт страницу клиента, а не корень сайта, когда модель дописала свой путь', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { landingUrl: 'https://okna-spb.ru/akcii' } }),
      [...CLIENT_SAID, 'вот страница: okna-spb.ru/lp'],
    );
    expect(result.draft.landingUrl).toBe('https://okna-spb.ru/lp');
  });

  it('берёт адрес из ответа клиента, если модель переписала его латиницей', () => {
    const result = applyTurnUpdates({}, turn({ updates: { landingUrl: 'https://okna-spb.ru' } }), [
      ...CLIENT_SAID,
      'сайт окна-спб.рф',
    ]);
    expect(result.draft.landingUrl).toBe('https://xn----7sbe7apelp.xn--p1ai/');
    expect(result.corrected[0]).toMatchObject({ field: 'landingUrl' });
  });

  it('не принимает выдуманный адрес за адрес клиента, если тот назвал два сайта', () => {
    // В последнем ответе два адреса, ни один не совпал с тем, что записала модель:
    // угадывать, который из них посадочная, дороже, чем спросить ещё раз.
    const result = applyTurnUpdates({}, turn({ updates: { landingUrl: 'https://okna-spb.ru' } }), [
      ...CLIENT_SAID,
      'мы как okna-piter.ru, только дешевле, ещё есть vk.com/okna',
    ]);
    expect(result.draft.landingUrl).toBeUndefined();
  });

  it('не принимает за адрес сокращение с точкой', () => {
    // «ул.Ленина» — не сайт: иначе клиент купил бы трафик на несуществующий домен.
    const result = applyTurnUpdates({}, turn({ updates: { landingUrl: 'https://okna-spb.ru' } }), [
      ...CLIENT_SAID,
      'офис на ул.Ленина, сайта пока нет',
    ]);
    expect(result.draft.landingUrl).toBeUndefined();
  });

  /**
   * Домен из почты — не сайт клиента.
   *
   * Ветка «модель прочитала последний ответ как ссылку» брала оттуда единственный
   * похожий на адрес токен и писала его в бриф, ни с чем не сверяя. Бриф уезжал
   * COMPLETE, план строился за два платных вызова, а `Ads.add` получал
   * `Href = https://gmail.com/` — клиент платил за клики на почтовый сервис.
   */
  it('не принимает домен из почты клиента за его сайт', () => {
    const result = applyTurnUpdates({}, turn({ updates: { landingUrl: 'https://okna-vsem.ru' } }), [
      'Продаём окна',
      'Сайта нет, пиши на ivan@gmail.com',
    ]);
    expect(result.draft.landingUrl).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'landingUrl', reason: 'url-not-mentioned' });
  });

  it('не принимает за сайт чужой адрес из последнего ответа клиента', () => {
    // Ни счётчик Метрики, ни группа в ВК не имеют отношения к тому, что записала
    // модель: одинокий адрес в ответе — ещё не подтверждение её выдумки.
    const said = [
      'Метрика вот https://metrika.yandex.ru/dashboard?id=12345',
      'Сайта нет, только группа vk.com/okna_spb',
      'Пиши на ivan.petrov@okna.ru',
    ];
    for (const message of said) {
      const result = applyTurnUpdates(
        {},
        turn({ updates: { landingUrl: 'https://okna-vsem.ru' } }),
        ['Продаём окна', message],
      );
      expect(result.draft.landingUrl).toBeUndefined();
      expect(result.rejected[0]).toMatchObject({
        field: 'landingUrl',
        reason: 'url-not-mentioned',
      });
    }
  });

  it('не принимает домен почты, даже когда модель записала его буква в букву', () => {
    // Совпадение строк тут ничего не доказывает: `okna.ru` есть в тексте только
    // внутри «ivan@okna.ru». Клиент назвал почту, а не сайт, — и спросить про сайт
    // ещё раз дешевле, чем купить ему трафик на угаданный домен.
    const result = applyTurnUpdates({}, turn({ updates: { landingUrl: 'https://okna.ru' } }), [
      ...CLIENT_SAID,
      'сайта нет, пиши на ivan@okna.ru',
    ]);
    expect(result.draft.landingUrl).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'landingUrl', reason: 'url-not-mentioned' });
  });

  it('принимает адрес клиента, в котором модель исправила опечатку', () => {
    // Ради этого случая ветка и писалась: модель поправила переставленные буквы,
    // а в бриф уезжает то, что написал клиент.
    const result = applyTurnUpdates({}, turn({ updates: { landingUrl: 'https://okna-spb.ru' } }), [
      ...CLIENT_SAID,
      'сайт okna-sbp.ru',
    ]);
    expect(result.draft.landingUrl).toBe('https://okna-sbp.ru/');
    expect(result.corrected[0]).toMatchObject({ field: 'landingUrl' });
  });

  it('не трогает исходный черновик', () => {
    const draft = { product: 'Пылесосы' };
    applyTurnUpdates(draft, turn({ updates: { product: 'Не пылесосы' } }), []);
    expect(draft.product).toBe('Пылесосы');
  });
});

describe('mentionsWebAddress', () => {
  it('видит адрес, как его пишут клиенты', () => {
    expect(mentionsWebAddress('наш сайт okna-spb.ru')).toBe(true);
    expect(mentionsWebAddress('окна-спб.рф')).toBe(true);
    expect(mentionsWebAddress('https://okna-spb.ru/lp?utm=tg')).toBe(true);
    expect(mentionsWebAddress('только группа vk.com/okna')).toBe(true);
  });

  it('не принимает за адрес обычный текст с точками', () => {
    expect(mentionsWebAddress('сайта нет, только страница в ВК')).toBe(false);
    expect(mentionsWebAddress('офис на ул.Ленина')).toBe(false);
    expect(mentionsWebAddress('бюджет 12.500 в сутки')).toBe(false);
    expect(mentionsWebAddress('импланты, виниры и т.д.')).toBe(false);
  });

  it('видит адрес в незнакомой зоне', () => {
    // Клиента в паузе просят прислать ссылку текстом. Если этот текст не опознан,
    // он остаётся в паузе навсегда, делая ровно то, о чём его попросили.
    expect(mentionsWebAddress('Сайт на тильде: mysite.tilda.ws')).toBe(true);
    expect(mentionsWebAddress('okna.moscow')).toBe(true);
  });

  it('не считает адресом сайта почту клиента', () => {
    // «Сайта нет, пиши на почту» — это ответ «сайта нет», а не присланная ссылка:
    // иначе клиент услышит про «разберётся человек» и снимет паузу повтором почты.
    expect(mentionsWebAddress('сайта нет, пиши на ivan@mail.ru')).toBe(false);
    expect(mentionsWebAddress('почта ivan.petrov@mail.ru')).toBe(false);
    expect(mentionsWebAddress('пиши на ivan@gmail.com, сайта нет')).toBe(false);
  });

  it('видит сайт рядом с почтой', () => {
    expect(mentionsWebAddress('сайт okna-spb.ru, почта ivan@gmail.com')).toBe(true);
  });

  it('не считает адресом зону, которая одновременно обычное слово', () => {
    // География в брифе обязательна, поэтому «г.Москва» приходит от каждого
    // второго клиента. Пока это читалось как адрес, клиенту без сайта система
    // отвечала «ссылку я вижу», в аудит это уезжало как error вместо warn, и
    // каждое следующее название города снимало паузу и оплачивало ход модели.
    expect(mentionsWebAddress('Мы в г.Москва работаем')).toBe(false);
    expect(mentionsWebAddress('работаем по г.москва и области')).toBe(false);
    expect(mentionsWebAddress('обучаем детей.Онлайн курсы тоже есть')).toBe(false);
    expect(mentionsWebAddress('делаем ремонт.Сайт пока не сделали')).toBe(false);
  });

  it('ссылку в такой зоне видит по признаку адреса, а не по зоне', () => {
    // Обратная сторона: клиента в паузе просят прислать ссылку — и то, что он
    // пришлёт, обязано быть опознано.
    expect(mentionsWebAddress('https://дети.онлайн')).toBe(true);
    expect(mentionsWebAddress('www.дети.онлайн')).toBe(true);
    expect(mentionsWebAddress('дети.онлайн/kursy')).toBe(true);
  });
});
