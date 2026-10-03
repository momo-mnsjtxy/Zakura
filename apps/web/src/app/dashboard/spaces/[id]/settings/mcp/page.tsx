"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CloudDownload, RefreshCw, Store } from "lucide-react";
import {
  fetchAgent,
  fetchAgentProviders,
  saveAgentProviders,
  statusVariant,
  type AgentDetail,
  type AgentProviderOptions,
} from "@/lib/agents";
import { useAgentDetail } from "@/components/agent-detail-context";
import {
  McpPromptsExplorer,
  McpResourcesExplorer,
  McpToolsExplorer,
} from "@/components/mcp/capability-explorers";
import {
  SettingsHeader,
  SettingsRow,
  SettingsSaveIndicator,
  SettingsSection,
} from "@/components/settings-shell";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { PageLoading } from "@/components/ui/progress-linear";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createLatestRequestGate } from "@/lib/chat-state";
import { buildMcpBindingPatch, deriveMcpBinding } from "@/lib/integration-settings-state";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

function providerLabel(id: string) {
  switch (id) {
    case "generic-mcp":
      return "HTTP";
    case "stdio-mcp":
      return "Stdio";
    case "openviking":
      return "OpenViking";
    default:
      return id;
  }
}

type McpBindingState = {
  mode: "all" | "selected";
  selected: string[];
  exposeFs: boolean;
};

export default function AgentMcpPage() {
  const { id } = useAgentDetail();
  const [opts, setOpts] = useState<AgentProviderOptions | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [state, setState] = useState<McpBindingState | null>(null);
  const [capsBusy, setCapsBusy] = useState(false);
  const [tab, setTab] = useState("bindings");
  const selectedRef = useRef<string[]>([]);
  const bindingLoadGate = useRef(createLatestRequestGate());
  const capabilityLoadGate = useRef(createLatestRequestGate());

  const loadBindings = useCallback(async () => {
    const requestId = bindingLoadGate.current.begin();
    try {
      const p = await fetchAgentProviders(id);
      if (!bindingLoadGate.current.isCurrent(requestId)) return;
      setOpts(p);
      const next = deriveMcpBinding(p);
      selectedRef.current = next.selected;
      setState(next as McpBindingState);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const loadCapabilities = useCallback(async () => {
    const requestId = capabilityLoadGate.current.begin();
    setCapsBusy(true);
    try {
      const d = await fetchAgent(id);
      if (capabilityLoadGate.current.isCurrent(requestId)) setDetail(d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (capabilityLoadGate.current.isCurrent(requestId)) setCapsBusy(false);
    }
  }, [id]);

  useEffect(() => {
    void loadBindings();
  }, [loadBindings]);

  useEffect(() => {
    if (tab !== "bindings" && !detail) {
      void loadCapabilities();
    }
  }, [tab, detail, loadCapabilities]);

  const persist = useCallback(
    async (patch: Partial<McpBindingState>) => {
      const res = await saveAgentProviders(id, buildMcpBindingPatch(
        { mode: state?.mode, selected: selectedRef.current, exposeFs: state?.exposeFs },
        patch,
      ) as Parameters<typeof saveAgentProviders>[1]);
      setOpts(res.options);
      const nextState = deriveMcpBinding(res.options);
      const nextSelected = nextState.selected;
      selectedRef.current = nextSelected;
      setState(nextState as McpBindingState);
      setDetail(null);
    },
    [id, state?.mode, state?.exposeFs],
  );

  const { status, error, saveNow } = useAutoSave(persist);

  function setMode(mode: "all" | "selected") {
    setState((prev) => (prev ? { ...prev, mode } : prev));
    saveNow({ mode });
  }

  function setExposeFs(exposeFs: boolean) {
    setState((prev) => (prev ? { ...prev, exposeFs } : prev));
    saveNow({ exposeFs });
  }

  function toggleInstance(instanceId: string, on: boolean) {
    setState((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.selected);
      if (on) set.add(instanceId);
      else set.delete(instanceId);
      const selected = [...set];
      selectedRef.current = selected;
      saveNow({ selected, mode: "selected" });
      return { ...prev, selected, mode: "selected" };
    });
  }

  if (!opts || !state) {
    return <PageLoading />;
  }

  const instances = opts.mcp.instances;
  const selectedSet = new Set(state.selected);
  const tools =
    detail?.tools.map((t) => ({
      qualifiedName: t.name,
      description: t.description,
      providerId: t.providerId,
      inputSchema: t.inputSchema,
      agentScoped: t.agentScoped,
    })) ?? [];
  const resources = detail?.resources ?? [];
  const prompts = detail?.prompts ?? [];
  const templates = detail?.resourceTemplates ?? [];

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="MCP"
        actions={
          <>
            {tab === "bindings" ? (
              <>
                <SettingsSaveIndicator status={status} error={error} />
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/dashboard/mcp/store" />}
                >
                  <Store />
                  商店
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/dashboard/mcp/import" />}
                >
                  <CloudDownload />
                  导入
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={capsBusy}
                onClick={() => void loadCapabilities()}
              >
                <RefreshCw className={capsBusy ? "animate-spin" : undefined} />
                刷新
              </Button>
            )}
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v) setTab(v);
        }}
      >
        <TabsList variant="line" className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="bindings">绑定</TabsTrigger>
          <TabsTrigger value="tools">
            工具{detail ? ` · ${tools.length}` : ""}
          </TabsTrigger>
          <TabsTrigger value="resources">
            资源
            {detail
              ? ` · ${resources.length}${templates.length ? ` / 模板 ${templates.length}` : ""}`
              : ""}
          </TabsTrigger>
          <TabsTrigger value="prompts">
            Prompts{detail ? ` · ${prompts.length}` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bindings" className="mt-4 space-y-4">
          <SettingsSection>
            <SettingsRow label="暴露工作区文件" htmlFor="mcp-expose-fs">
              <Switch
                id="mcp-expose-fs"
                checked={state.exposeFs}
                onCheckedChange={(v) => setExposeFs(Boolean(v))}
              />
            </SettingsRow>
            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
              <div className="text-sm font-medium">挂载模式</div>
              <Select
                value={state.mode}
                onValueChange={(v) => {
                  if (v === "all" || v === "selected") setMode(v);
                }}
                items={[
                  { value: "all", label: "全部" },
                  { value: "selected", label: "仅所选" },
                ]}
              >
                <SelectTrigger className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="selected">仅所选</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SettingsSection>

          {instances.length === 0 ? (
            <div className="rounded-lg border border-dashed py-12 text-center">
              <p className="mb-3 text-sm text-muted-foreground">暂无 MCP 实例</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/dashboard/mcp/store" />}
                >
                  <Store />
                  商店
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/dashboard/mcp/import" />}
                >
                  <CloudDownload />
                  导入
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">绑定</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {instances.map((inst) => {
                    const bound =
                      state.mode === "all" ? true : selectedSet.has(inst.id);
                    return (
                      <TableRow key={inst.id}>
                        <TableCell>
                          <Link
                            href={`/dashboard/mcp/${inst.id}`}
                            className="font-medium underline-offset-2 hover:underline"
                          >
                            {inst.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <code className="text-[11px] text-muted-foreground">
                            {inst.slug}
                          </code>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {providerLabel(inst.providerId)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(inst.status)}>
                            {inst.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            checked={bound}
                            disabled={state.mode === "all"}
                            onCheckedChange={(v) =>
                              toggleInstance(inst.id, Boolean(v))
                            }
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          {capsBusy && !detail ? (
            <PageLoading />
          ) : (
            <McpToolsExplorer
              tools={tools}
              agentId={id}
              emptyHint="当前绑定下暂无聚合工具（请确认实例运行中）"
            />
          )}
        </TabsContent>

        <TabsContent value="resources" className="mt-4">
          {capsBusy && !detail ? (
            <PageLoading />
          ) : (
            <McpResourcesExplorer
              resources={resources}
              templates={templates}
              agentId={id}
              emptyHint="当前绑定下暂无资源"
            />
          )}
        </TabsContent>

        <TabsContent value="prompts" className="mt-4">
          {capsBusy && !detail ? (
            <PageLoading />
          ) : (
            <McpPromptsExplorer
              prompts={prompts}
              agentId={id}
              emptyHint="当前绑定下暂无 Prompts"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
