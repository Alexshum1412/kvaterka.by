import type { Metadata } from 'next';
import { redirect } from '@/i18n/navigation.ts';
import { getLocale, getTranslations } from 'next-intl/server';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready } from '@/server/runtime.ts';
import { ListingWizard } from '@/ui/listing-wizard.tsx';
import type { AmenityOption } from '@/ui/search-filters.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('ListingWizard');
  return { title: t('newMetaTitle'), robots: { index: false, follow: false } };
}

/**
 * A new listing starts with no row at all.
 *
 * The wizard creates one as soon as the first question is answered and
 * rewrites the URL to the edit route, so a refresh at any point after
 * that lands on a real draft rather than starting over. Nothing is
 * created just by opening this page — otherwise every idle visit would
 * leave an empty draft in the landlord's dashboard.
 */
export default async function NewListingPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/dashboard/listings/new'), locale });

  const database = await ready();
  const amenities = await database.query<AmenityOption>(
    `SELECT code, category, name_ru, name_be, name_en, icon FROM amenity ORDER BY sort_order`,
  );

  return <ListingWizard listing={null} amenities={amenities.rows} />;
}
