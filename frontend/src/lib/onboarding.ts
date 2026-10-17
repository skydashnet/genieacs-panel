/**
 * Where the browser remembers that a provider's onboarding was finished or
 * skipped. Lives apart from the page so the shell can read it without
 * pulling the page into the main chunk.
 */
export const onboardingDismissKey = (slug: string) => `onboarding:dismissed:${slug}`
