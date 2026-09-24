/**
 * notifications — visibility
 * Field-level redaction. NotificationDto has no sensitive fields that need
 * to be hidden from the owning user. All fields are already safe to return.
 *
 * If a future admin role can read any user's notifications, add isVisible()
 * and redact() here to strip PII (e.g. body text referencing payment amounts
 * from a corporate-admin view where the booking-person doesn't have access).
 */
export {};
