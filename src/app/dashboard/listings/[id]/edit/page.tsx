import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { ListingWizard, type WizardListing } from '@/ui/listing-wizard.tsx';
import type { AmenityOption } from '@/ui/search-filters.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Редактирование объявления',
  robots: { index: false, follow: false },
};

export default async function EditListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(signInUrl(`/dashboard/listings/${id}/edit`));

  const services = await readyServices();

  let listing: WizardListing;
  try {
    // getForOwner answers "not found" for somebody else's listing, so a
    // stranger cannot tell an existing draft from a missing one.
    listing = (await services.listings.getForOwner(id, user.userId)) as unknown as WizardListing;
  } catch {
    notFound();
  }

  const database = await ready();
  const amenities = await database.query<AmenityOption>(
    `SELECT code, category, name_ru, icon FROM amenity ORDER BY sort_order`,
  );

  return <ListingWizard listing={listing} amenities={amenities.rows} />;
}
