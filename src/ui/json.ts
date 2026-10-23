export function queryTerms(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

const OPAQUE_MIN = 200;

// Long encrypted_content style values are opaque. They hide behind a placeholder until revealed.
export function displayJson(payload: unknown, reveal: boolean): { text: string; hidden: number } {
  let hidden = 0;
  let json: string | undefined;
  try {
    json = JSON.stringify(payload, (key, value: unknown) => {
      if (!reveal && typeof value === "string" && value.length >= OPAQUE_MIN && /encrypted/i.test(key)) {
        hidden++;
        return `[encrypted, ${value.length} characters, hidden]`;
      }
      return value;
    }, 2);
  } catch {
    json = undefined;
  }
  return { text: json ?? "(no content)", hidden };
}

export function highlightParts(source: string, terms: string[]): { text: string; match: boolean }[] {
  if (!terms.length || source.length > 400_000) return [{ text: source, match: false }];
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return source.split(pattern).filter((part) => part !== "").map((part, index) => ({ text: part, match: index % 2 === 1 }));
}
