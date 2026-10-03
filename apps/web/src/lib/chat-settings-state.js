/** Convert editable sheet state to the server's sparse config patch contract. */
export function buildChatSettingsPatch(patch) {
  const body = {};
  for (const key of ["systemPrompt", "enableTools", "autoMemory", "autoTitle", "followUpMode"]) {
    if (patch[key] !== undefined) body[key] = patch[key];
  }
  if (patch.maxSubagentDepth !== undefined) {
    const parsed = Number(patch.maxSubagentDepth);
    body.maxSubagentDepth =
      Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 5) : null;
  }
  if (patch.approvalsPolicy !== undefined) {
    body.approvals = { policy: patch.approvalsPolicy };
  }
  return body;
}
