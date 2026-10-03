"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, setSession } from "@/lib/api";
import { AuthScreen } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";
import { AuthMfaChallenge } from "@/components/auth-mfa-challenge";
import { AuthMfaEnrollment } from "@/components/auth-mfa-enrollment";
import { authCallbackResult } from "@/lib/auth-callback-state";
import { createActionLock } from "@/lib/auth-flow";

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState<{ ticket: string; methods: string[] } | null>(null);
  const [enrollmentTicket, setEnrollmentTicket] = useState<string | null>(null);
  const [next, setNext] = useState("/dashboard/agents");
  const exchange = useRef(createActionLock());

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    void (async () => {
      if (!code || !state) {
        setError("缺少授权码");
        return;
      }
      if (!exchange.current.acquire()) return;
      try {
        const res = await api<{ session?: string; mfaRequired?: boolean; mfaTicket?: string; methods?: string[]; mfaEnrollmentRequired?: boolean; mfaEnrollmentTicket?: string; tenant?: { onboardingCompleted?: boolean } }>(
          "/api/auth/sso/oidc/callback",
          { method: "POST", json: { code, state } },
        );
        const destination = res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents";
        const result = authCallbackResult(res);
        setNext(destination);
        if (result.kind === "mfa") { setMfa({ ticket: result.ticket, methods: result.methods }); return; }
        if (result.kind === "enrollment") { setEnrollmentTicket(result.ticket); return; }
        if (result.kind === "error") throw new Error(result.message);
        setSession(result.session);
        router.replace(destination);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        exchange.current.release();
      }
    })();
  }, [params, router]);

  if (enrollmentTicket) return <AuthScreen title="保护你的账号" description="团队要求启用身份验证器。"><AuthMfaEnrollment ticket={enrollmentTicket} onSession={(result) => { setSession(result.session); router.replace(next); }} /></AuthScreen>;
  if (mfa) return <AuthScreen title="需要二次验证" description="完成验证后继续登录。"><AuthMfaChallenge ticket={mfa.ticket} methods={mfa.methods} onSession={(session) => { setSession(session); router.replace(next); }} onCancel={() => router.replace("/login")} /></AuthScreen>;
  if (!error) return <PageLoading />;
  return (
    <AuthScreen title="登录未完成" description={error}>
      <Button size="lg" className="w-full" variant="outline" nativeButton={false} render={<Link href="/login" />}>
        返回登录
      </Button>
    </AuthScreen>
  );
}

export default function OidcSsoCallbackPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Inner />
    </Suspense>
  );
}
