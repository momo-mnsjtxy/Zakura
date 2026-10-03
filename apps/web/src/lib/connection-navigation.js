export function legacyConnectionDestination(search) {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const source = params.get("source") ?? "";
  if (tab === "credentials") return "/dashboard/settings/oauth-clients";
  if (tab !== "store") return "/dashboard/agents";
  if (
    source.startsWith("skill") ||
    source.includes("claude") ||
    source.includes("codex") ||
    source.includes("plugin") ||
    source.includes("openai")
  ) return "/dashboard/skills";
  if (source.includes("official") || source === "mcp-official") {
    return "/dashboard/mcp/store";
  }
  return "/dashboard/mcp/store?tab=community";
}
