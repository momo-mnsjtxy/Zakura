export function fieldsForProtocol(protocol, protocols) {
  return protocols.find((entry) => entry.protocol === protocol)?.fields ?? ["baseUrl", "apiKey"];
}

export function normalizeProtocolCatalog(protocols) {
  return protocols.map((protocol) => {
    const isAgent = protocol.group === "agent";
    const supplied = Array.isArray(protocol.fields) ? protocol.fields : undefined;
    const fields = new Set(
      supplied && (supplied.length > 0 || isAgent) ? supplied : ["baseUrl", "apiKey"],
    );
    fields.add("baseUrl");
    return { ...protocol, fields: [...fields] };
  });
}

export function buildUpstreamConfig(form, fields, defaultBaseUrl) {
  const config = {};
  if (fields.includes("apiKey") && form.apiKey.trim()) config.apiKey = form.apiKey.trim();
  config.baseUrl = form.baseUrl.trim() || defaultBaseUrl;
  if (fields.includes("apiVersion")) config.apiVersion = form.apiVersion.trim();
  if (fields.includes("anthropicVersion")) {
    config.anthropicVersion = form.anthropicVersion.trim() || "2023-06-01";
  }
  for (const key of ["deploymentId", "rerankBaseUrl"]) {
    if (fields.includes(key) && form[key].trim()) config[key] = form[key].trim();
  }
  if (fields.includes("region")) config.region = form.region;
  return config;
}

export function validateUpstreamForm({ name, protocol, apiKey, baseUrl, defaultBaseUrl, fields, editing, agent }) {
  if (!name.trim()) return "请填写名称";
  if (!editing && fields.includes("apiKey") && !apiKey.trim() && protocol !== "custom" && !agent) {
    return "请填写 API Key";
  }
  if (!baseUrl.trim() && !defaultBaseUrl) return "请填写 API 地址";
  return null;
}
