export type PendingAuth = {
  clientRedirectUri: string;
  clientState?: string;
  codeVerifier: string;
  downstreamCodeChallenge?: string;
  createdAt: number;
};

export type AuthorizationGrant = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  createdAt: number;
  downstreamCodeChallenge?: string;
};

/** Process-local bounded state store. Deployments can replace this module with
 * a shared encrypted implementation without changing the HTTP protocol. */
export class BridgeStateStore {
  private readonly pending = new Map<string, PendingAuth>();
  private readonly grants = new Map<string, AuthorizationGrant>();
  private readonly ttlMs: number;
  constructor(ttlMs = 15 * 60 * 1000) { this.ttlMs = ttlMs; }
  purge(now = Date.now()): void {
    const cutoff = now - this.ttlMs;
    for (const [key, value] of this.pending) if (value.createdAt < cutoff) this.pending.delete(key);
    for (const [key, value] of this.grants) if (value.createdAt < cutoff) this.grants.delete(key);
  }
  putPending(state: string, value: PendingAuth): void { this.pending.set(state, value); }
  takePending(state: string): PendingAuth | undefined {
    const value = this.pending.get(state);
    this.pending.delete(state);
    return value;
  }
  putGrant(code: string, value: AuthorizationGrant): void { this.grants.set(code, value); }
  getGrant(code: string): AuthorizationGrant | undefined { return this.grants.get(code); }
  consumeGrant(code: string): void { this.grants.delete(code); }
}
