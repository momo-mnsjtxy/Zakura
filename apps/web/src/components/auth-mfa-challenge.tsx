"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { createActionLock } from "@/lib/auth-flow";
import { AuthField } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Mode = "totp" | "webauthn" | "recovery";

export function AuthMfaChallenge({ ticket, methods, onSession, onCancel }: {
  ticket: string;
  methods: string[];
  onSession: (session: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>(methods.includes("webauthn") ? "webauthn" : "totp");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const tried = useRef(false);
  const action = useRef(createActionLock());

  async function complete(extra: Record<string, unknown>) {
    if (!action.current.acquire()) return;
    setLoading(true);
    try {
      const result = await api<{ session: string }>("/api/auth/mfa/complete", {
        method: "POST", json: { ticket, ...extra },
      });
      if (!result.session) throw new Error("登录响应无效，请重新登录");
      await onSession(result.session);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setLoading(false);
      action.current.release();
    }
  }

  async function passkey() {
    if (!action.current.acquire()) return;
    setLoading(true);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const options = await api<Record<string, unknown>>("/api/auth/mfa/webauthn/options", {
        method: "POST", json: { ticket },
      });
      const webauthn = await startAuthentication({ optionsJSON: options } as never);
      action.current.release();
      await complete({ webauthn });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NotAllowedError") {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      setLoading(false);
      action.current.release();
    }
  }

  useEffect(() => {
    if (mode !== "webauthn" || tried.current) return;
    tried.current = true;
    void passkey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (mode === "webauthn") return (
    <div className="space-y-3">
      <Button type="button" className="h-10 w-full" disabled={loading} onClick={() => void passkey()}>
        {loading ? <Loader2 className="animate-spin" /> : null}{loading ? "等待设备…" : "使用通行密钥"}
      </Button>
      <div className="flex flex-wrap justify-center gap-4 text-sm">
        {methods.includes("totp") ? <button type="button" onClick={() => { setMode("totp"); setCode(""); }} className="text-muted-foreground hover:text-foreground">改用验证码</button> : null}
        <button type="button" onClick={() => { setMode("recovery"); setCode(""); }} className="text-muted-foreground hover:text-foreground">使用恢复码</button>
      </div>
    </div>
  );

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void complete(mode === "recovery" ? { recoveryCode: code } : { totp: code }); }}>
      <AuthField label={mode === "recovery" ? "恢复码" : "验证码"} htmlFor="mfa-code">
        <Input id="mfa-code" className="h-10 tracking-widest" inputMode={mode === "totp" ? "numeric" : "text"} autoComplete={mode === "totp" ? "one-time-code" : "off"} autoFocus value={code} onChange={(event) => setCode(event.target.value)} />
      </AuthField>
      <Button type="submit" className="h-10 w-full" disabled={loading || code.trim().length < 6}>{loading ? <Loader2 className="animate-spin" /> : null}{loading ? "验证中…" : "验证"}</Button>
      <div className="flex flex-wrap justify-center gap-4 text-sm">
        {mode !== "totp" && methods.includes("totp") ? <button type="button" onClick={() => { setMode("totp"); setCode(""); }} className="text-muted-foreground hover:text-foreground">改用验证码</button> : null}
        {methods.includes("webauthn") ? <button type="button" onClick={() => { tried.current = false; setMode("webauthn"); }} className="text-muted-foreground hover:text-foreground">改用通行密钥</button> : null}
        {mode !== "recovery" ? <button type="button" onClick={() => { setMode("recovery"); setCode(""); }} className="text-muted-foreground hover:text-foreground">使用恢复码</button> : null}
      </div>
      {onCancel ? <p className="text-center text-sm"><button type="button" onClick={onCancel} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronLeft className="size-3.5" />更换方式</button></p> : null}
    </form>
  );
}
