"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageLoading } from "@/components/ui/progress-linear";
import { legacyConnectionDestination } from "@/lib/connection-navigation";

/** 统一连接中心已拆回 MCP / Skills / 凭据独立入口 */
function ConnectionsRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    router.replace(legacyConnectionDestination(searchParams.toString()));
  }, [router, searchParams]);

  return <PageLoading />;
}

export default function LegacyConnectionsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ConnectionsRedirectInner />
    </Suspense>
  );
}
