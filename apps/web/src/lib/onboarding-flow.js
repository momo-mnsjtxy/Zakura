export const ONBOARDING_STEPS = ["choose", "mcp", "connect", "provider", "name"];

export function moveOnboarding(state, next, direction = "forward") {
  if (!ONBOARDING_STEPS.includes(next)) return state;
  return { step: next, direction };
}

export function isUnauthorizedOnboardingError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("unauthorized") || /(^|\D)401(\D|$)/.test(message);
}
