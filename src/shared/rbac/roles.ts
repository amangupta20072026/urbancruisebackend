/**
 * ==============================================================================
 * Roles + customer taxonomy — SSoT for the app's user model
 * ==============================================================================
 * Kept structurally aligned with the RN app's `src/rbac/roles.ts` so client
 * and server never disagree about role semantics.
 *
 * TYPE SURFACE covers all four roles because the JWT payload carries `role`
 * regardless of which features are implemented server-side. RUNTIME behavior
 * is narrower — see `authenticate.ts`, which rejects any non-customer role
 * with 403 `ROLE_NOT_ENABLED` until the corresponding features land. When
 * (say) vendor features ship, delete that guard branch; nothing else changes.
 * ==============================================================================
 */

// ── Top-level role ─────────────────────────────────────────────────────────
export type UserRole = 'customer' | 'vendor' | 'driver' | 'uc';

// ── Customer taxonomy ──────────────────────────────────────────────────────
// The customer domain has two levels:
//   Category — high-level classification (personal / corporate / agent)
//   Type     — specific sub-classification within a category
//
// Category and type are NOT independent. A "personal" customer can only have
// type "personal"; a "corporate" customer picks from the corporate types;
// an "agent" picks from the agent types. Modeling them as a discriminated
// union (`CustomerClassification` below) makes invalid combinations impossible
// to construct at compile time.
//
// `companyName` is required for corporate + agent, absent for personal —
// same discriminated union expresses that constraint.

export type CustomerCategory = 'personal' | 'corporate' | 'agent';

/** Only value for category='personal'. */
export type PersonalCustomerType = 'personal';

/** Sub-types under category='corporate'. */
export type CorporateCustomerType =
  'company' | 'ngo' | 'educationalInstitute' | 'sportingCompany' | 'government';

/** Sub-types under category='agent'. */
export type AgentCustomerType = 'travelAgent' | 'tourOperator' | 'hotel' | 'weddingPlanner' | 'dmc';

/** Union of every legal customer-type value, regardless of category. */
export type CustomerType = PersonalCustomerType | CorporateCustomerType | AgentCustomerType;

/**
 * The customer classification block. Use wherever a customer's category /
 * type / company name appear together — schema validation, DB row projection,
 * DTOs, etc. TypeScript refuses any of these bad shapes:
 *   { category: 'personal', type: 'company' }          // wrong type for personal
 *   { category: 'corporate', companyName: null }       // company name required
 *   { category: 'agent', type: 'ngo' }                 // ngo isn't an agent type
 */
export type CustomerClassification =
  | { category: 'personal'; type: PersonalCustomerType; companyName: null }
  | { category: 'corporate'; type: CorporateCustomerType; companyName: string }
  | { category: 'agent'; type: AgentCustomerType; companyName: string };

// ── Sub-roles ──────────────────────────────────────────────────────────────
// Corporate customers can have multiple logins under the same CustomerId with
// different privileges — a booking-person places bookings, an admin can also
// manage seats / cancel / pay. Personal customers and agents have no sub-role
// today (agent sub-roles are TBD).
//
// Vendor has four operational roles sharing one VendorId; type carried here
// so JWTs from a fully-integrated vendor client parse correctly. Runtime is
// still blocked at the auth guard until vendor features ship.
export type CorporateSubRole = 'bookingPerson' | 'admin';
export type VendorSubRole = 'owner' | 'bookingManager' | 'opsManager' | 'accountsManager';

/** Sub-role attached to an identity. null for roles that don't use one. */
export type SubRole = CorporateSubRole | VendorSubRole | null;
