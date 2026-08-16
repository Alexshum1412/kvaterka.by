import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SiteHeader } from '@/ui/site-header';
import { SiteFooter } from '@/ui/site-footer';
import { currentUser } from '@/server/session.ts';

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
  // One value, matching the page ground. The app no longer follows the OS
  // colour scheme (DEC-023), so advertising a dark chrome colour would
  // paint the browser's toolbar navy above a light page.
  themeColor: '#f7f9fc',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Published once, on the document, so client components can tell a
  // signed-out visitor from a signed-in one without asking the server.
  // Before this, every anonymous page view fired a /api/favorites request
  // that could only ever 401 — a wasted round trip and a red line in the
  // console on a page where nothing is wrong.
  const viewer = await currentUser();

  return (
    <html lang="ru">
      <body data-auth={viewer ? 'user' : 'anon'}>
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
