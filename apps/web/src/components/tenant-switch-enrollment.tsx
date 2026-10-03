"use client";

import { AuthMfaEnrollment } from "@/components/auth-mfa-enrollment";
import { setSession } from "@/lib/api";

export function TenantSwitchEnrollment({ ticket, destination, onClose }: { ticket: string; destination: string; onClose: () => void }) {
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-background/90 p-6 backdrop-blur-sm"><div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-5 shadow-xl"><div><h2 className="font-heading text-lg font-semibold">保护你的账号</h2><p className="text-sm text-muted-foreground">切换到该团队前需要启用身份验证器。</p></div><AuthMfaEnrollment ticket={ticket} onSession={(result) => { setSession(result.session); window.location.href = destination; }} /><button type="button" onClick={onClose} className="w-full text-sm text-muted-foreground hover:text-foreground">取消切换</button></div></div>;
}
