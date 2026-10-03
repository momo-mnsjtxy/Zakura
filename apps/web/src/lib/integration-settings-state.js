export function deriveMcpBinding(options) {
  const selected = options.mcp.instances.filter((instance) => instance.bound).map((instance) => instance.id);
  return {
    mode: options.mcp.mode,
    selected,
    exposeFs: options.mcp.exposeWorkspaceFs !== false,
  };
}

export function buildMcpBindingPatch(current, patch) {
  const mode = patch.mode ?? current.mode ?? "selected";
  const selected = patch.selected ?? current.selected ?? [];
  const exposeFs = patch.exposeFs ?? current.exposeFs ?? true;
  return {
    mcp: {
      mode,
      instanceIds: mode === "selected" ? [...new Set(selected)] : undefined,
      exposeWorkspaceFs: exposeFs,
    },
  };
}

export function filterCustomSkillSources(sources) {
  return (sources ?? []).filter((source) =>
    source.removable || source.format === "claude" || source.format === "codex" || source.id.startsWith("custom:"),
  );
}

export function createOauthResultGate() {
  let settled = false;
  return {
    accept() {
      if (settled) return false;
      settled = true;
      return true;
    },
  };
}
