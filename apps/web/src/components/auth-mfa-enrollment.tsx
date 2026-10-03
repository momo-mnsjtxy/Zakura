"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { createActionLock } from "@/lib/auth-flow";
import { enrollmentCompletionResult } from "@/lib/auth-callback-state";
import { AuthField } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Setup = { secret?: string; otpauthUrl?: string; qrCode?: string; qrCodeDataUrl?: string };

export function AuthMfaEnrollment({ ticket, onSession }: {
  ticket: string;
  onSession: (result: { session: string; tenant?: { onboardingCompleted?: boolean } }) => void | Promise<void>;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [completed, setCompleted] = useState<{ session: string; tenant?: { onboardingCompleted?: boolean } } | null>(null);
  const action = useRef(createActionLock());

  async function start() {
    setBusy(true);
    try {
      const result = await api<Setup>("/api/auth/mfa/enrollment/totp/start", { method: "POST", json: { ticket } });
      setSetup(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  useEffect(() => { void start(); }, [ticket]);

  async function complete() {
    if (!action.current.acquire()) return;
    setBusy(true);
    try {
      const result = await api<{ session: string; recoveryCodes?: string[]; tenant?: { onboardingCompleted?: boolean } }>("/api/auth/mfa/enrollment/totp/complete", { method: "POST", json: { ticket, code: code.trim() } });
      const outcome = enrollmentCompletionResult(result);
      if (outcome.kind === "error") throw new Error(outcome.message);
      if (outcome.kind === "recovery") { setRecoveryCodes(outcome.recoveryCodes ?? []); setCompleted(result); }
      else await onSession(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      action.current.release();
    } finally { setBusy(false); }
  }

  if (recoveryCodes.length && completed) return <div className="space-y-4"><p className="text-sm text-muted-foreground">请保存这些恢复码。每个恢复码只能使用一次。</p><div className="grid grid-cols-2 gap-2 rounded-lg border p-3 font-mono text-sm">{recoveryCodes.map((item) => <span key={item}>{item}</span>)}</div><Button className="w-full" onClick={() => void onSession(completed)}>我已保存，继续</Button></div>;
  if (!setup) return <div className="space-y-3 text-center"><Loader2 className="mx-auto animate-spin" />{!busy ? <Button variant="outline" onClick={() => void start()}>重试</Button> : null}</div>;
  const qr = setup.qrCodeDataUrl ?? setup.qrCode;
  return <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void complete(); }}>{qr ? <img src={qr} alt="MFA 二维码" className="mx-auto size-44 rounded-md border" /> : null}<p className="text-sm text-muted-foreground">用身份验证器扫描二维码，然后输入 6 位验证码。</p>{setup.secret ? <code className="block break-all rounded-md border p-2 text-xs">{setup.secret}</code> : null}<AuthField label="验证码" htmlFor="enrollment-code"><Input id="enrollment-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} /></AuthField><Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>{busy ? <Loader2 className="animate-spin" /> : null}启用并继续</Button></form>;
}
