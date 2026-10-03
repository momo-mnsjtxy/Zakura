export function authCallbackResult(response) {
  if (response?.mfaEnrollmentRequired && response?.mfaEnrollmentTicket) {
    return { kind: "enrollment", ticket: response.mfaEnrollmentTicket, methods: response.methods ?? ["totp"] };
  }
  if (response?.mfaRequired && response?.mfaTicket) {
    return { kind: "mfa", ticket: response.mfaTicket, methods: response.methods ?? [] };
  }
  if (response?.session) return { kind: "session", session: response.session };
  return { kind: "error", message: "登录响应无效，请重新登录" };
}

export function createCallbackAttemptGate() {
  let generation = 0;
  return {
    begin() { const token = ++generation; return () => token === generation; },
    invalidate() { generation += 1; },
  };
}

export function enrollmentCompletionResult(response) {
  if (!response?.session) return { kind: "error", message: "登录响应无效，请重新登录" };
  const recoveryCodes = Array.isArray(response.recoveryCodes)
    ? [...new Set(response.recoveryCodes.filter((item) => typeof item === "string" && item.trim()))]
    : [];
  return recoveryCodes.length
    ? { kind: "recovery", session: response.session, recoveryCodes, tenant: response.tenant }
    : { kind: "session", session: response.session, tenant: response.tenant };
}
