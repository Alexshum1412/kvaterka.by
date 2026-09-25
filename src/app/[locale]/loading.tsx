import { getTranslations } from 'next-intl/server';

/**
 * What a navigation shows while the next page renders (DEC-086).
 *
 * Every page here is `force-dynamic` and queries the database per request, and
 * there was not a single loading boundary in the app: on a slow shared host a
 * click left the old page frozen under the cursor with no sign anything was
 * happening. This paints instantly inside the layout — header and footer stay
 * — as a neutral page-shaped skeleton, and tells assistive tech in words.
 */
export default async function Loading() {
  const t = await getTranslations('Layout');
  return (
    <div className="container ld" role="status" aria-busy="true">
      <span className="sr-only">{t('loadingPage')}</span>
      <div className="skeleton ld__title" aria-hidden="true" />
      <div className="skeleton ld__line" aria-hidden="true" />
      <div className="skeleton ld__line ld__line--short" aria-hidden="true" />
      <div className="skeleton ld__block" aria-hidden="true" />
      <style>{`
        .ld { display: grid; gap: var(--space-3); padding-block: var(--space-6) var(--space-8); }
        .ld__title { height: 2.25rem; width: min(24rem, 70%); border-radius: var(--radius-sm); }
        .ld__line { height: 1rem; width: min(38rem, 100%); border-radius: var(--radius-full); }
        .ld__line--short { width: min(22rem, 60%); }
        .ld__block { height: 16rem; margin-top: var(--space-3); border-radius: var(--radius-md); }
      `}</style>
    </div>
  );
}
