export function profilePatch({ name, title, bio }) {
  return { name: name.trim(), title: title.trim(), bio: bio.trim() };
}

export function teamDestination(team) {
  return team?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents";
}

export function oauthClientGroups(payload) {
  return { inbound: payload.inbound ?? [], dcr: payload.dcr ?? [], byo: payload.byo ?? [] };
}

export function sessionRecovery(status) {
  return status === 401 || status === 403 ? { clearSession: true, destination: "/login" } : null;
}
