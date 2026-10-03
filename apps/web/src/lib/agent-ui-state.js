export function buildAgentCreateInput({ name, spaceId, description }) {
  const normalizedName = name.trim();
  if (!normalizedName) return { error: "请填写名称" };
  if (!spaceId) return { error: "请选择所属空间" };
  return {
    value: {
      name: normalizedName,
      spaceId,
      description: description.trim() || undefined,
      createApiKey: false,
    },
  };
}

function boundedNumber(value, { min, max = Infinity, allowEmpty = true }) {
  const text = String(value).trim();
  const number = Number(text);
  if ((allowEmpty && !text) || !Number.isFinite(number) || number < min) return null;
  return Math.min(Math.floor(number), max);
}

export function splitAgentSettingsPatch(patch) {
  const agent = {};
  const providers = {};
  const cloud = {};
  if (patch.name !== undefined) agent.name = patch.name.trim() || undefined;
  if (patch.description !== undefined) agent.description = patch.description;
  if (patch.enableMemory !== undefined) agent.enableMemory = patch.enableMemory;
  if (patch.webSearchEnabled !== undefined) providers.webSearch = { enabled: patch.webSearchEnabled };
  if (patch.webFetchEnabled !== undefined) providers.webFetch = { enabled: patch.webFetchEnabled };
  if (patch.exposeWorkspaceFs !== undefined) providers.mcp = { exposeWorkspaceFs: patch.exposeWorkspaceFs };
  for (const key of ["systemPrompt", "autoCompact", "enableTools", "autoMemory", "autoTitle"]) {
    if (patch[key] !== undefined) cloud[key] = patch[key];
  }
  for (const key of ["model", "modelRouteId", "compactModel", "compactModelRouteId"]) {
    if (patch[key] !== undefined) cloud[key] = patch[key] || null;
  }
  const specs = {
    compactThresholdChars: { min: 8000 },
    compactSoftThresholdChars: { min: 4000 },
    compactKeepRecent: { min: 4, max: 64 },
    compactKeepRecentChars: { min: 4000, max: 200000 },
    maxToolResultChars: { min: 1000, max: 80000 },
    maxToolRounds: { min: 1 },
    maxSubagentDepth: { min: 1, max: 5, allowEmpty: false },
  };
  for (const [key, spec] of Object.entries(specs)) {
    if (patch[key] !== undefined) cloud[key] = boundedNumber(patch[key], spec);
  }
  return { agent, providers, cloud };
}

export function agentAfterClose(spaces) {
  return {
    name: "",
    description: "",
    spaceId: spaces.find((space) => space.isDefault)?.id ?? spaces[0]?.id ?? "",
  };
}
