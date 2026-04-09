/**
 * Parsea una cadena JSON que puede estar envuelta en bloques de código markdown.
 * Retorna `null` si el texto está vacío o no es JSON válido.
 */
export function parseStableJson(text: string): unknown {
  if (!text) return null;

  let clean = text.trim();

  // Eliminar delimitadores de bloque de código markdown
  if (clean.startsWith("```json")) clean = clean.slice(7);
  else if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.endsWith("```")) clean = clean.slice(0, -3);

  clean = clean.trim();

  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}
