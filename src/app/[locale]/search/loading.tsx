import { getTranslations } from 'next-intl/server';
import { CardSkeleton } from '@/ui/primitives.tsx';

/**
 * Search's own skeleton: six card-shaped placeholders proportioned like the
 * real cards, so results land without a reflow. It had been written (as
 * `SearchSkeleton` in page.tsx) and never rendered by anything.
 */
export default async function SearchLoading() {
  const t = await getTranslations('Layout');
  return (
    <div className="container container-wide" role="status" aria-busy="true" style={{ paddingBlock: 'var(--space-5) var(--space-7)' }}>
      <span className="sr-only">{t('loadingPage')}</span>
      <div
        style={{
          display: 'grid',
          gap: 'var(--space-5) var(--space-4)',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))',
        }}
      >
        {Array.from({ length: 6 }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
