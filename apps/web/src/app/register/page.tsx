"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";
import { registrationRedirect } from "@/lib/auth-flow";

/** 注册收进登录页。旧链接转到 /login?mode=register。 */
export default function RegisterPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(registrationRedirect(window.location.search));
  }, [router]);
  return <PageLoading />;
}
