/**
 * Create's legal pages (2026-10-04, launch item "Legal links + terms acceptance"). The ONE place their
 * addresses live: the dashboard footer and sign-up form, the Create Admin login and the storefront's
 * "Powered by Create" link all import from here, so a moved page is a one-line change.
 *
 * Deliberately free of imports (no zod), so any app — including the admin, which otherwise does not
 * depend on this package's schemas — can take it through the `@create/shared/legal` subpath.
 */
export const LEGAL_LINKS = {
  termsOfService: 'https://www.create.com/policies/terms-of-service',
  privacyPolicy: 'https://www.create.com/policies/privacy-policy',
  acceptableUsePolicy: 'https://www.create.com/policies/acceptable-use-policy',
  cookiePolicy: 'https://www.create.com/policies/cookie-policy',
  dataProcessingAddendum: 'https://www.create.com/policies/data-processing-addendum',
  privacyNotice: 'https://www.create.com/policies/privacy-notice',
  copyrightInfringementPolicy: 'https://www.create.com/policies/copyright-infringement-policy',
} as const;

export type LegalLinkKey = keyof typeof LEGAL_LINKS;

/**
 * The version of the Terms of Service (and the Acceptable Use Policy that is part of them) a person
 * agrees to at sign-up. The sign-up form sends the version it showed; the API accepts only this one
 * (`400 terms_version_outdated` otherwise) and records it on the user with the time of acceptance.
 * Bump it when the terms change materially.
 */
export const CURRENT_TERMS_VERSION = '2026-10-04';

export const TERMS_NOT_ACCEPTED_CODE = 'terms_not_accepted';
export const TERMS_NOT_ACCEPTED_MESSAGE = 'Agree to the Terms of Service and Acceptable Use Policy to create an account.';
export const TERMS_VERSION_OUTDATED_CODE = 'terms_version_outdated';
export const TERMS_VERSION_OUTDATED_MESSAGE = 'The Terms of Service have changed since this page loaded. Reload the page and try again.';

/** The footer links, in display order: what every Create-owned surface shows under its content. */
export const LEGAL_FOOTER_LINKS: ReadonlyArray<{ key: LegalLinkKey; label: string; href: string }> = [
  { key: 'termsOfService', label: 'Terms', href: LEGAL_LINKS.termsOfService },
  { key: 'privacyPolicy', label: 'Privacy', href: LEGAL_LINKS.privacyPolicy },
  { key: 'acceptableUsePolicy', label: 'Acceptable Use', href: LEGAL_LINKS.acceptableUsePolicy },
  { key: 'cookiePolicy', label: 'Cookies', href: LEGAL_LINKS.cookiePolicy },
  { key: 'dataProcessingAddendum', label: 'DPA', href: LEGAL_LINKS.dataProcessingAddendum },
  { key: 'copyrightInfringementPolicy', label: 'Copyright', href: LEGAL_LINKS.copyrightInfringementPolicy },
];
