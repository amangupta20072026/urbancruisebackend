/**
 * Branded id types: compile-time only, so one kind of id can't be passed
 * where another is expected. Cast at the boundary: `id as BookingId`.
 */

type Brand<K, T> = K & { readonly __brand: T };

export type UserId = Brand<string, 'UserId'>;
export type CustomerId = Brand<string, 'CustomerId'>;

export type EnquiryId = Brand<string, 'EnquiryId'>;
export type QuotationId = Brand<string, 'QuotationId'>;
export type BookingId = Brand<string, 'BookingId'>;
export type TripId = Brand<string, 'TripId'>;
export type PaymentId = Brand<string, 'PaymentId'>;
export type NotificationId = Brand<string, 'NotificationId'>;
