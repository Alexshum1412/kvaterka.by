import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/navigation.ts';
import { getLocale, getTranslations } from 'next-intl/server';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { ListingWizard, type WizardListing } from '@/ui/listing-wizard.tsx';
import type { AmenityOption } from '@/ui/search-filters.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('ListingWizard');
  return { title: t('editMetaTitle'), robots: { index: false, follow: false } };
}

export default async function EditListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl(`/dashboard/listings/${id}/edit`), locale });

  const services = await readyServices();

  let listing: WizardListing;
  try {
    // `redirect` above never returns, but next-intl's generic typing for it
    // doesn't narrow `user` for the type checker the way `next/navigation`'s
    // does.
    // getForOwner answers "not found" for somebody else's listing, so a
    // stranger cannot tell an existing draft from a missing one.
    listing = (await services.listings.getForOwner(id, user!.userId)) as unknown as WizardListing;
  } catch {
    notFound();
  }

  const database = await ready();
  const amenities = await database.query<AmenityOption>(
    `SELECT code, category, name_ru, name_be, name_en, icon FROM amenity ORDER BY sort_order`,
  );

  return <ListingWizard listing={listing} amenities={amenities.rows} />;
}
