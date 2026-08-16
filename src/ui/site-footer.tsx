import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer
      style={{
        borderTop: '1px solid var(--border)',
        marginTop: '4rem',
        padding: '2.5rem 0',
        background: 'var(--bg-raised)',
      }}
    >
      <div className="container stack" style={{ gap: '1.5rem' }}>
        <div
          style={{
            display: 'grid',
            gap: '1.5rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          }}
        >
          <div className="stack" style={{ gap: '0.5rem' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>Арендаторам</strong>
            <Link href="/search" className="footer-link">Поиск жилья</Link>
            <Link href="/how-it-works" className="footer-link">Как это работает</Link>
            <Link href="/trust" className="footer-link">Проверка и доверие</Link>
          </div>
          <div className="stack" style={{ gap: '0.5rem' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>Хозяевам</strong>
            <Link href="/host" className="footer-link">Сдать жильё</Link>
            <Link href="/host/fees" className="footer-link">Сервисный сбор</Link>
          </div>
          <div className="stack" style={{ gap: '0.5rem' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>Платформа</strong>
            <Link href="/terms" className="footer-link">Условия использования</Link>
            <Link href="/privacy" className="footer-link">Обработка данных</Link>
            <Link href="/support" className="footer-link">Поддержка</Link>
          </div>
        </div>

        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-subtle)', maxWidth: '75ch' }}>
          Kvaterka — площадка для размещения объявлений и общения между хозяином и арендатором.
          Платформа не является стороной договора аренды и не принимает арендную плату: расчёты
          стороны ведут между собой напрямую. Сервисный сбор 5% платит хозяин после подтверждённой
          сделки.
        </p>

        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-subtle)' }}>
          © {new Date().getFullYear()} Kvaterka. Беларусь.
        </p>
      </div>

      <style>{`
        .footer-link {
          font-size: var(--text-sm);
          color: var(--fg-muted);
          /* Padded so a thumb has room: these are standalone navigation
             links, not links inline in a sentence. */
          display: inline-block;
          padding-block: 0.3rem;
        }
        .footer-link:hover { color: var(--fg); text-decoration: underline; }
      `}</style>
    </footer>
  );
}
