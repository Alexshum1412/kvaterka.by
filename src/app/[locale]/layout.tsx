import type { Metadata, Viewport } from 'next';
import { Onest } from 'next/font/google';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import '../globals.css';
import { SiteHeader } from '@/ui/site-header.tsx';
import { SiteFooter } from '@/ui/site-footer.tsx';
import { ConsoleEasterEgg } from '@/ui/console-easter-egg.tsx';
import { currentUser } from '@/server/session.ts';
import { routing, type AppLocale } from '@/i18n/routing.ts';

/**
 * The one typeface, for body and display alike (see the `--font-sans` comment
 * in globals.css). `next/font` downloads and self-hosts the files at BUILD
 * time and serves them from this origin — nothing asks fonts.googleapis.com
 * for anything at runtime. Onest is a variable font (100–900 in one file per
 * subset); its `cyrillic` file is ~16 KB and was checked glyph by glyph for
 * ў Ў і І ё № before it replaced Inter, which had been loaded for headings
 * only and left body copy on whatever the visitor's OS happened to ship.
 */
const brandFont = Onest({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-brand',
  display: 'swap',
});

const OG_LOCALE: Record<AppLocale, string> = { ru: 'ru_BY', be: 'be_BY', en: 'en_US' };

export function generateStaticParams(): { locale: AppLocale }[] {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Metadata' });

  return {
    title: { default: t('homeTitle'), template: '%s · Кватэрка.by' },
    description: t('homeDescription'),
    openGraph: { type: 'website', locale: OG_LOCALE[locale as AppLocale] ?? OG_LOCALE.ru, siteName: 'Кватэрка.by' },
    robots: { index: true, follow: true },
    alternates: {
      languages: Object.fromEntries(routing.locales.map((l) => [l, l === routing.defaultLocale ? '/' : `/${l}`])),
    },
  };
}

/**
 * A function rather than a static object, because the one thing in here
 * that varies — themeColor — depends on the visitor's theme cookie: with
 * dark opt-in now real (DEC-023 stands, this is a person choosing, not the
 * OS choosing for them), the browser's own chrome should match what's on
 * the page, not silently disagree with it.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = (await cookies()).get('theme')?.value === 'dark' ? 'dark' : 'light';
  return {
    width: 'device-width',
    initialScale: 1,
    // Zoom is left enabled on purpose. Locking it breaks the page for anyone
    // who needs to magnify text, and it saves nothing.
    maximumScale: 5,
    themeColor: theme === 'dark' ? '#0c1424' : '#f7f9fc',
    // Without this, env(safe-area-inset-*) resolves to 0px and the fixed
    // booking dock / wizard nav bar that already code for the iPhone home
    // indicator stop actually clearing it.
    viewportFit: 'cover',
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Published once, on the document, so client components can tell a
  // signed-out visitor from a signed-in one without asking the server.
  // Before this, every anonymous page view fired a /api/favorites request
  // that could only ever 401 — a wasted round trip and a red line in the
  // console on a page where nothing is wrong.
  const viewer = await currentUser();
  const theme = (await cookies()).get('theme')?.value === 'dark' ? 'dark' : 'light';
  const [messages, t] = await Promise.all([getMessages(), getTranslations({ locale, namespace: 'Layout' })]);

  return (
    <html lang={locale} className={brandFont.variable} data-theme={theme === 'dark' ? 'dark' : undefined}>
      <body data-auth={viewer ? 'user' : 'anon'}>
        <NextIntlClientProvider messages={messages}>
          <ConsoleEasterEgg />
          <a className="skip-link" href="#main">
            {t('skipToContent')}
          </a>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
