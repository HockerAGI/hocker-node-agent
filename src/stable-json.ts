export function stableJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(input as Record<string, unknown>).sort()) {
        out[k] = walk((input as Record<string, unknown>)[k]);
      }
      return out;
    }
    return input;
  };

  return JSON.stringify(walk(value ?? {}));
}