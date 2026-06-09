import type { SearchParams } from "@/lib/sis/types";

export function termListKey(): string {
  return "terms:list";
}

export function searchKey(params: SearchParams): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(params).sort()) {
    sorted[k] = params[k as keyof SearchParams];
  }
  return `search:${JSON.stringify(sorted)}`;
}
