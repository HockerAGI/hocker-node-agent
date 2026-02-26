export function parseStableJson(text: string): any {
  if (!text) return null;
  let clean = text.trim();
  
  if (clean.startsWith("```json")) {
    clean = clean.replace(/^```json/, "");
  } else if (clean.startsWith("```")) {
    clean = clean.replace(/^```/, "");
  }
  
  if (clean.endsWith("```")) {
    clean = clean.replace(/```$/, "");
  }
  
  clean = clean.trim();
  
  try {
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}