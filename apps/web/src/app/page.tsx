"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type PlatformInfo, setSession } from "@/lib/api";
import { ErrorRecovery } from "@/components/error-recovery";

export default function HomePage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    (async () => {
      try {
        const platform = await api<PlatformInfo>("/api/platform");
        if (!active) return;
        if (!platform.setupCompleted) {
          router.replace("/setup");
          return;
        }
        const session = localStorage.getItem("zakura_session");
        if (!session) {
          router.replace("/login");
          return;
        }
        try {
          await api("/api/me");
          const current = await api<{ onboardingCompleted?: boolean }>("/api/tenant/current");
          if (!active) return;
          if (current.onboardingCompleted === false) {
            router.replace("/onboarding");
          } else {
            router.replace("/dashboard/agents");
          }
        } catch {
          setSession(null);
          router.replace("/login");
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [router, retryKey]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-sm">
        <ErrorRecovery
          title="无法连接 API"
          message={error}
          onRetry={() => setRetryKey((value) => value + 1)}
        />
      </div>
    );
  }

  return <div className="min-h-screen bg-background" />;
}
