import type { MetadataRoute } from 'next';

/**
 * The web app manifest — what a phone reads before it lets someone add this
 * site to a home screen. Static, not `force-dynamic`: nothing in it depends
 * on a request, a database, or an environment variable, so it can be built
 * once and cached like any other static asset.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Кватэрка.by — аренда жилья в Беларуси',
    short_name: 'Кватэрка.by',
    description: 'Аренда квартир и жилья в Беларуси без сюрпризов.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f9fc',
    theme_color: '#216aca',
    lang: 'ru',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
