import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SiteHeader } from '@/ui/site-header';
import { SiteFooter } from '@/ui/site-footer';

export const metadata: Metadata = {
  title: {
    default: 'Кватэрка.by — аренда жилья в Беларуси без сюрпризов',
    template: '%s · Кватэрка.by',
  },
  description:
    'Найдите квартиру на сутки, месяц или год. Честная итоговая цена, проверенные хозяева, ' +
    'отзывы после реальных сделок и вся история аренды в одном месте.',
  openGraph: {
    type: 'website',
    locale: 'ru_BY',
    siteName: 'Кватэрка.by',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is left enabled on purpose. Locking it breaks the page for anyone
  // who needs to magnify text, and it saves nothing.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f8fc' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <a className="skip-link" href="#main">
          Перейти к содержимому
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
