export function readLoginIntent(search) {
  const params = new URLSearchParams(search);
  return {
    suspendedReason:
      params.get("suspended") === "1"
        ? params.get("reason")?.trim() || "账号已被封禁"
        : null,
    email: params.get("email")?.trim() || "",
    mode: params.get("mode") === "register" ? "register" : "signin",
  };
}

export function loginCapabilities(platform) {
  const password = platform.passwordLoginEnabled !== false;
  const registration = Boolean(
    platform.registrationEnabled || (platform.edition === "saas" && password),
  );
  return {
    oauthProviders: (platform.oauthProviders ?? []).filter((provider) => provider.enabled),
    passwordLoginEnabled: password,
    registrationEnabled: registration,
    highlightedMethod: platform.highlightedLoginMethod || "auto",
  };
}

export function resolveEmailDiscovery(found, capabilities) {
  const hint = found.sso && found.protocol
    ? { protocol: found.protocol, tenantSlug: found.tenantSlug }
    : null;
  if (found.required && hint) return { action: "sso", hint };
  if (found.required) {
    return { action: "notice", hint: null, message: "该邮箱需通过公司 SSO 登录，请联系管理员完成配置。" };
  }
  if (hint && !capabilities.passwordLoginEnabled) return { action: "sso", hint };
  if (!capabilities.passwordLoginEnabled) {
    return {
      action: "notice",
      hint,
      message: capabilities.oauthProviders.length
        ? "请使用上方方式登录。"
        : "当前没有可用的登录方式，请联系管理员。",
    };
  }
  return { action: "password", hint };
}

export function createActionLock() {
  let locked = false;
  return {
    acquire() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
    get locked() {
      return locked;
    },
  };
}

export function registrationRedirect(search) {
  const email = new URLSearchParams(search).get("email")?.trim();
  return email
    ? `/login?mode=register&email=${encodeURIComponent(email)}`
    : "/login?mode=register";
}

export function loginReturnHref(email) {
  const normalized = email.trim();
  return normalized ? `/login?email=${encodeURIComponent(normalized)}` : "/login";
}
