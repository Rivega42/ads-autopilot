'use client';

export interface ErrorPageProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * Текст ошибки наружу не выводится: в нём бывает строка подключения к БД.
 * Для разбора остаётся `digest` — по нему запись находится в логах сервера.
 */
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <section className="notice">
      <h1>Не удалось загрузить данные</h1>
      <p className="page-sub">
        Скорее всего, дашборд не видит базу: проверьте <code>DATABASE_URL</code> и что Postgres
        поднят.
      </p>
      {error.digest ? <p className="muted">Идентификатор ошибки: {error.digest}</p> : null}
      <p>
        <button className="button" type="button" onClick={reset}>
          Повторить
        </button>
      </p>
    </section>
  );
}
