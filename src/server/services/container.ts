/**
 * Service container.
 *
 * Plain construction, no DI framework: the graph is shallow and every service
 * takes exactly one dependency (the database). A container here is worth having
 * only because it gives the HTTP layer and the tests one identical entry point.
 */

import type { Db } from '../db/sql.ts';
import { AuthService } from '../auth/auth-service.ts';
import { AvailabilityService } from './availability-service.ts';
import { BookingService } from './booking-service.ts';
import { DashboardService } from './dashboard-service.ts';
import { FinanceService } from './finance-service.ts';
import { ListingService } from './listing-service.ts';
import { MessagingService } from './messaging-service.ts';
import { NotificationService } from './notification-service.ts';
import { ReviewService } from './review-service.ts';
import { SearchService } from './search-service.ts';
import { TrustService } from './trust-service.ts';

export interface Services {
  readonly auth: AuthService;
  readonly listings: ListingService;
  readonly search: SearchService;
  readonly availability: AvailabilityService;
  readonly bookings: BookingService;
  readonly dashboard: DashboardService;
  readonly reviews: ReviewService;
  readonly messaging: MessagingService;
  readonly notifications: NotificationService;
  readonly trust: TrustService;
  readonly finance: FinanceService;
}

export function createServices(db: Db): Services {
  return {
    auth: new AuthService(db),
    listings: new ListingService(db),
    search: new SearchService(db),
    availability: new AvailabilityService(db),
    bookings: new BookingService(db),
    dashboard: new DashboardService(db),
    reviews: new ReviewService(db),
    messaging: new MessagingService(db),
    notifications: new NotificationService(db),
    trust: new TrustService(db),
    finance: new FinanceService(db),
  };
}
