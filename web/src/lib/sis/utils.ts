import { parse } from "node-html-parser";

export function extractSynchronizerToken(html: string): string {
  const root = parse(html);
  const meta = root.querySelector('meta[name="synchronizerToken"]');
  if (!meta) {
    throw new Error("synchronizerToken meta tag not found in HTML response");
  }
  const content = meta.getAttribute("content");
  if (!content) {
    throw new Error("synchronizerToken meta tag has no content attribute");
  }
  return content;
}

export function generateUniqueSessionId(): string {
  const digits = Math.floor(Math.random() * 1e14)
    .toString()
    .padStart(14, "0");
  return `h3if${digits}`;
}

export function parseCookies(headers: Headers): Map<string, string> {
  const cookies = new Map<string, string>();
  const setCookieHeader = headers.getSetCookie
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ?? "").split(/,(?=[^ ])/);

  for (const raw of setCookieHeader) {
    const [pair] = raw.split(";");
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    cookies.set(name, value);
  }
  return cookies;
}

export function buildCookieHeader(cookies: Map<string, string>): string {
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
