export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function requestJson(url: string): Promise<unknown> {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    !(
      [
        "api.mullvad.net",
        "ipv4.am.i.mullvad.net",
        "ipv6.am.i.mullvad.net",
      ].includes(target.hostname) ||
      /^[a-f0-9-]+\.dnsleak\.am\.i\.mullvad\.net$/.test(target.hostname)
    )
  ) {
    throw new Error("Unapproved diagnostic endpoint");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error("Mullvad endpoint unavailable");
    // Bound both the response and the wait; do not retain response bodies in errors.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response");
    let text = "";
    let size = 0;
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error("Response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    clearTimeout(timeout);
  }
}
