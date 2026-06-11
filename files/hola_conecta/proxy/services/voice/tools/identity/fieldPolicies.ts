export type FieldSensitivity = 'low' | 'pii' | 'internal' | 'custom';
export type FieldSource = 'contacts' | 'custom_field_values';

export type ContactFieldPolicy = {
  key: string;
  label: string;
  source: FieldSource;
  sensitivity: FieldSensitivity;
  canReadBeforePin: boolean;
  canReadWithPin: boolean;
  canUpdateWithPin: boolean;
};

export const STANDARD_POLICIES: ContactFieldPolicy[] = [
  { key: 'first_name', label: 'First name', source: 'contacts', sensitivity: 'low', canReadBeforePin: true, canReadWithPin: true, canUpdateWithPin: false },
  { key: 'preferred_language', label: 'Preferred language', source: 'contacts', sensitivity: 'low', canReadBeforePin: true, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'phone_last4', label: 'Phone last four', source: 'contacts', sensitivity: 'low', canReadBeforePin: true, canReadWithPin: true, canUpdateWithPin: false },
  { key: 'email_domain', label: 'Email domain', source: 'contacts', sensitivity: 'low', canReadBeforePin: true, canReadWithPin: true, canUpdateWithPin: false },
  { key: 'email', label: 'Email', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'phone', label: 'Phone', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'address_line1', label: 'Address line 1', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'address_line2', label: 'Address line 2', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'city', label: 'City', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'state', label: 'State', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'postal_code', label: 'Postal code', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'birthday', label: 'Birthday', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: false },
  { key: 'sms_opt_in', label: 'SMS opt in', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'email_opt_in', label: 'Email opt in', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true },
  { key: 'whatsapp_opt_in', label: 'WhatsApp opt in', source: 'contacts', sensitivity: 'pii', canReadBeforePin: false, canReadWithPin: true, canUpdateWithPin: true }
];

export const BLOCKED_STANDARD_FIELDS = [
  'notes',
  'balance_due',
  'assigned_to',
  'source',
  'clients',
  'leads',
  'is_placeholder'
];

export const STANDARD_POLICY_BY_KEY = new Map(STANDARD_POLICIES.map((policy) => [policy.key, policy]));
