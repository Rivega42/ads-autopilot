# Метрика на smartsay.ru — что передать разработчику сайта

Готовые файлы и точки вызова. Это **не код ads-autopilot** — это то, что нужно
вставить в проект сайта. Без счётчика реклама запускается вслепую:
не работают автостратегии, ретаргетинг и любая оценка CPL.

## 1. Создать счётчик

metrika.yandex.ru → «Добавить счётчик». Домен `smartsay.ru`, часовой пояс
Europe/Moscow. Включить **Вебвизор**, **Карту скроллинга**, **Аналитику форм**.
Полученный ID подставить в `metrika.ts` вместо `0`.

## 2. Вставить счётчик в `index.html`

В `<head>`, до подключения бандла:

```html
<script type="text/javascript">
  (function (m, e, t, r, i, k, a) {
    m[i] =
      m[i] ||
      function () {
        (m[i].a = m[i].a || []).push(arguments);
      };
    m[i].l = 1 * new Date();
    for (var j = 0; j < document.scripts.length; j++) {
      if (document.scripts[j].src === r) return;
    }
    k = e.createElement(t);
    a = e.getElementsByTagName(t)[0];
    k.async = 1;
    k.src = r;
    a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');

  ym(СЮДА_ID_СЧЁТЧИКА, 'init', {
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
    webvisor: true,
    trackHash: true,
  });
</script>
<noscript
  ><div>
    <img
      src="https://mc.yandex.ru/watch/СЮДА_ID_СЧЁТЧИКА"
      style="position:absolute; left:-9999px;"
      alt=""
    /></div
></noscript>
```

## 3. Скопировать два файла

| Отсюда                                               | Куда в проекте сайта                   |
| ---------------------------------------------------- | -------------------------------------- |
| [`metrika.ts`](./metrika.ts)                         | `src/analytics/metrika.ts`             |
| [`useMetrikaPageViews.ts`](./useMetrikaPageViews.ts) | `src/analytics/useMetrikaPageViews.ts` |

Сайт — SPA на React Router: при переходах между разделами страница не
перезагружается, и без хука счётчик засчитает только первый экран. Хук
вызывается один раз внутри роутера — например, в общем Layout.

## 4. Расставить цели

| Где в коде                       | Вызов                                          |
| -------------------------------- | ---------------------------------------------- |
| Успешная отправка формы записи   | `reachGoal('form_lead', { language, format })` |
| Форма на `/preschool`            | `reachGoal('form_lead_preschool')`             |
| Форма на `/camp`                 | `reachGoal('form_lead_camp')`                  |
| Клик по `tel:` в шапке и подвале | `reachGoal('click_phone')`                     |
| Клик по Telegram/мессенджеру     | `reachGoal('click_messenger')`                 |
| Клик по `mailto:`                | `reachGoal('click_email')`                     |
| Кнопка «Открыть в Яндекс.Картах» | `reachGoal('click_maps')`                      |
| Завершение теста `/smarttest`    | `reachGoal('test_completed', { score })`       |
| Открытие блока цен               | `reachGoal('viewed_pricing')`                  |

Цель вызывается **после успешного ответа сервера**, а не по клику на кнопку:
иначе в конверсии попадут все, у кого форма упала с ошибкой.

```ts
const response = await sendLeadForm(values);
if (response.ok) {
  reachGoal('form_lead', { language: values.language, format: values.format });
}
```

## 5. Завести цели в интерфейсе Метрики

Метрика → Настройки → Цели → «JavaScript-событие», идентификатор совпадает
с именем из таблицы. Ценности целей — в
[`../02-metrika.md`](../02-metrika.md#3-настроить-цели).

## 6. Проверить

1. Открыть сайт, перейти между разделами → в Метрике «Отчёты → Посещаемость»
   должно быть больше одного просмотра за визит.
2. Отправить тестовую заявку → цель `form_lead` засчиталась.
3. Только после этого включать рекламу.

## Заодно почините

`/og-image.jpg`, `/logo.png` и `/favicon.ico` на сервере отсутствуют — вместо
файлов отдаётся `index.html`. Ссылки на них стоят в мета-тегах, поэтому превью
при репостах и иконка вкладки сейчас сломаны.
