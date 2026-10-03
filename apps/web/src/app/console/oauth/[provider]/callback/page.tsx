"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { api, setSession } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/progress-linear";
import { AuthScreen } from "@/components/auth-screen";
import { AuthMfaChallenge } from "@/components/auth-mfa-challenge";
import { AuthMfaEnrollment } from "@/components/auth-mfa-enrollment";
import { authCallbackResult } from "@/lib/auth-callback-state";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const routeParams = useParams<{ provider: string }>();
  const provider = routeParams.provider;
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState<{ ticket: string; methods: string[] } | null>(null);
  const [enrollmentTicket, setEnrollmentTicket] = useState<string | null>(null);
  const [destination, setDestination] = useState("/dashboard/agents");

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");
    const errDesc = params.get("error_description");

    void (async () => {
      if (!provider || err || !code || !state) {
        setError(errDesc || err || (!provider ? "缺少 OAuth 提供商" : "缺少授权码"));
        return;
      }
      try {
        const res = await api<{
          session?: string;
          next?: string;
          tenant?: { onboardingCompleted?: boolean };
          mfaRequired?: boolean; mfaTicket?: string; methods?: string[];
          mfaEnrollmentRequired?: boolean; mfaEnrollmentTicket?: string;
        }>(`/api/auth/oauth/${encodeURIComponent(provider)}/callback`, {
          method: "POST",
          json: { code, state },
        });
        const next =
          res.next ??
          (res.tenant?.onboardingCompleted === false ? "/onboarding" : "/dashboard/agents");
        setDestination(next);
        const result = authCallbackResult(res);
        if (result.kind === "mfa") { setMfa({ ticket: result.ticket, methods: result.methods }); return; }
        if (result.kind === "enrollment") { setEnrollmentTicket(result.ticket); return; }
        if (result.kind === "error") throw new Error(result.message);
        setSession(result.session);
        router.replace(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, provider, router]);

  if (enrollmentTicket) return <AuthScreen title="保护你的账号" description="团队要求启用身份验证器。"><AuthMfaEnrollment ticket={enrollmentTicket} onSession={(result) => { setSession(result.session); router.replace(destination); }} /></AuthScreen>;
  if (mfa) return <AuthScreen title="需要二次验证" description="完成验证后继续登录。"><AuthMfaChallenge ticket={mfa.ticket} methods={mfa.methods} onSession={(session) => { setSession(session); router.replace(destination); }} onCancel={() => router.replace("/login")} /></AuthScreen>;
  if (!error) {
    // 成功路径：静默加载，浏览器进度条已足够反馈
    return <PageLoading />;
  }

  return (
    <div className="grid min-h-svh place-items-center p-6">
      <div className="w-full max-w-xs space-y-5 animate-in-page text-center">
        <div className="flex items-center justify-center">
          <div className="flex size-10 items-center justify-center rounded-lg border border-destructive/30 text-destructive">
            <X className="size-4" />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/login" />}>
          返回登录
        </Button>
      </div>
    </div>
  );
}

export default function OauthLoginCallbackPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CallbackInner />
    </Suspense>
  );
}
