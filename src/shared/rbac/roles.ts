/**
 * User roles and customer classification types. Should match the mobile
 * app's role definitions. Which roles may log in is controlled by
 * ENABLED_ROLES (see enabled-roles.ts). There are no sub-roles.
 */

export type UserRole = 'customer' | 'vendor' | 'driver' | 'uc';

// Customer category and its allowed types.

export type CustomerCategory = 'personal' | 'corporate' | 'agent';

/** Types for category 'personal'. */
export type PersonalCustomerType = 'personal';

/** Types for category 'corporate'. */
export type CorporateCustomerType =
  'company' | 'ngo' | 'educationalInstitute' | 'sportingCompany' | 'government';

/** Types for category 'agent'. */
export type AgentCustomerType = 'travelAgent' | 'tourOperator' | 'hotel' | 'weddingPlanner' | 'dmc';

/** Any customer type. */
export type CustomerType = PersonalCustomerType | CorporateCustomerType | AgentCustomerType;

/**
 * Valid category/type/companyName combinations. Invalid ones (e.g. a
 * personal customer with type 'company') do not compile. companyName is
 * required for corporate and agent customers.
 */
export type CustomerClassification =
  | { category: 'personal'; type: PersonalCustomerType; companyName: null }
  | { category: 'corporate'; type: CorporateCustomerType; companyName: string }
  | { category: 'agent'; type: AgentCustomerType; companyName: string };
