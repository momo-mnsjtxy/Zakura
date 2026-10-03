export function buildSpaceCreateInput({ name, description }) {
  const normalized = name.trim();
  if (!normalized) return { error: "请填写名称" };
  return { value: { name: normalized, description: description.trim() || undefined } };
}

export function buildSpaceUpdateInput({ name, description }) {
  const normalized = name.trim();
  if (!normalized) return { error: "请填写名称" };
  return { value: { name: normalized, description: description.trim() } };
}

export function filterSpaceAgents(agents, spaceId) {
  return agents.filter((agent) => agent.spaceId === spaceId);
}

export function automationPrompt(goal) {
  return [
    "请用 create_routine 为我创建定时或事件任务（Routine）。",
    "根据下面描述自行决定名称、触发方式（cron 或 listener）和任务意图，创建后用一两句话确认。",
    "",
    goal.trim(),
  ].join("\n");
}
