/**
 * Decode an API response without assuming that every endpoint returns JSON.
 * Proxies and auth gateways commonly return an empty body or plain text while
 * restarting; surfacing that response is much more useful than hiding it behind
 * a JSON parse failure.
 *
 * @param {Response} response
 * @returns {Promise<Record<string, unknown>>}
 */
export async function decodeApiResponse(response) {
  if (response.status === 204 || response.status === 205) return {};

  const body = await response.text();
  if (!body.trim()) return {};

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json") || /^[\s]*[\[{]/.test(body)) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      return { data: parsed };
    } catch {
      // Fall through so a malformed gateway response is still visible.
    }
  }

  return { error: body.trim() };
}

/** @param {number} status */
export function isTransientHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
