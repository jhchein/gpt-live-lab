export interface SearchSource {
  id: string;
  title: string;
  url: string;
  content: string;
  lastUpdatedAt?: string;
  contentTier?: string;
}

export function sourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch {
    return;
  }
}

export function citedSourceIds(text: string, sources: SearchSource[]): string[] {
  const known = new Set(sources.map((source) => source.id));
  return [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))]
    .filter((id) => known.has(id));
}
