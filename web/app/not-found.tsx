import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="card">
      <h1>Страница не найдена</h1>
      <p className="page-sub">Возможно, кампанию или клиента удалили из базы.</p>
      <p>
        <Link href="/clients">К списку клиентов</Link>
      </p>
    </section>
  );
}
