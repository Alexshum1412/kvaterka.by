import type { AnyRoute } from '../http.ts';
import { authRoutes } from './auth.ts';
import { listingRoutes } from './listings.ts';
import { searchRoutes } from './search.ts';
import { bookingRoutes } from './bookings.ts';
import { favoriteRoutes } from './favorites.ts';
import { chatRoutes, dashboardRoutes, notificationRoutes, profileRoutes, reviewRoutes } from './social.ts';
import { adminRoutes, financeRoutes } from './admin.ts';
import { staffRoutes } from './staff.ts';
import { accountSelfRoutes, retentionStaffRoutes } from './retention.ts';
import { twoFactorRoutes } from './two-factor.ts';
import { verificationSelfRoutes, verificationStaffRoutes } from './verification.ts';
import { defineRoute } from '../http.ts';

/** Liveness/readiness. No auth, no rate limit — monitoring must always reach it. */
const systemRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/health',
    summary: 'Health check',
    tags: ['system'],
    auth: 'none',
    async handler({ ctx }) {
      const started = Date.now();
      await ctx.db.query('SELECT 1');
      return { status: 'ok', databaseLatencyMs: Date.now() - started };
    },
  }),
];

export const allRoutes: AnyRoute[] = [
  ...systemRoutes,
  ...authRoutes,
  ...profileRoutes,
  ...dashboardRoutes,
  ...listingRoutes,
  ...searchRoutes,
  ...favoriteRoutes,
  ...bookingRoutes,
  ...reviewRoutes,
  ...chatRoutes,
  ...notificationRoutes,
  ...financeRoutes,
  ...staffRoutes,
  ...accountSelfRoutes,
  ...twoFactorRoutes,
  ...retentionStaffRoutes,
  ...verificationSelfRoutes,
  ...verificationStaffRoutes,
  ...adminRoutes,
];
