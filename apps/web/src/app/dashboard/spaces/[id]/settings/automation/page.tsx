"use client";

/**
 * Agent 设置 · 自动化
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAgentDetail } from "@/components/agent-detail-context";
import { SettingsHeader } from "@/components/settings-shell";
import { AutomationPanel } from "@/components/chat/automation-panel";
import { PageLoading } from "@/components/ui/progress-linear";
import { listAgentProjects } from "@/lib/agent-fs";
import { automationPrompt } from "@/lib/space-ui-state";

export default function AgentAutomationPage() {
  const router = useRouter();
  const { id, agent, loading } = useAgentDetail();
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    listAgentProjects(id)
      .then((res) => {
        if (!cancelled) setProjects(res.projects.map((p) => p.slug));
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading || !agent) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-4">
      <SettingsHeader
        title="自动化"
        description="定时与事件任务（Routine）"
      />
      <div className="max-w-md overflow-hidden rounded-lg bg-card shadow-surface-2">
        <AutomationPanel
          agentId={id}
          projects={projects}
          className="max-h-[min(70vh,36rem)]"
          onAskAgentCreate={(goal) => {
            const prompt = automationPrompt(goal);
            try {
              sessionStorage.setItem("zakura_pending_prompt", prompt);
            } catch {
              /* ignore */
            }
            router.push(`/chat?agent=${id}`);
          }}
          onOpenSession={(sid) => {
            router.push(`/chat?agent=${id}&session=${sid}`);
          }}
        />
      </div>
    </div>
  );
}
