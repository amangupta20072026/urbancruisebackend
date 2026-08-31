/**
 * ==============================================================================
 * Branded ID types
 * ==============================================================================
 * Marketing a `string` as a `BookingId` prevents accidents like passing a
 * `CustomerId` where a `BookingId` was expected — TypeScript rejects it at
 * compile time. Zero runtime cost.
 *
 * SCOPE (step-one): only customer-side IDs. Vehicle/Vendor/Driver/UcUser/
 * Staff/Issue IDs will be added when their features land.
 *
 * Cast at the boundary:
 *     const id = req.params.id as BookingId;
 * ...and then the type system does the rest.
 * ==============================================================================
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
