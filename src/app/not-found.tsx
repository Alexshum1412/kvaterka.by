import Link from 'next/link';

/**
 * The 404.
 *
 * This route mattered more than a missing page usually does, because 404 is
 * load-bearing in this product: every screen a caller may not see answers 404
 * rather than 403, so that an address cannot be used to discover that
 * something exists. Without this file all of those answers rendered the
 * framework's unstyled default — which reads as a broken site to the ordinary
 * person who simply mistyped, and tells the prober they found something
 * unusual.
 */
export default function NotFound() {
  return (
    <div className="container nf">
      <h1>Страница не найдена</h1>
      <p>
        Возможно, адрес набран с ошибкой, объявление сняли с публикации или у этой страницы другой
        владелец.
      </p>
      <div className="nf__actions">
        <Link href="/search" className="btn btn-primary">
          Смотреть квартиры
        </Link>
        <Link href="/" className="btn btn-secondary">
          На главную
        </Link>
      </div>

      <style>{`
        .nf { max-width: 32rem; padding-block: var(--space-8); text-align: center; }
        .nf h1 { font-size: var(--text-2xl); font-weight: 600; }
        .nf p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-3); }
        .nf__actions { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: center; margin-top: var(--space-5); }
      `}</style>
    </div>
  );
}
