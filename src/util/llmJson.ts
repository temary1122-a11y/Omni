/**
 * Best-effort extraction of a JSON payload from a raw LLM response.
 *
 * Models frequently wrap JSON in markdown code fences, add prose around it, or
 * emit the JSON inside a `reasoning` field instead of `content`. This walks the
 * available candidates and returns the first substring that parses as JSON.
 *
 * @param content   Primary model response body.
 * @param reasoning Optional reasoning/thinking text to fall back to.
 * @param fallback  Returned when nothing parses (defaults to `content ?? ''`).
 */
export function extractJsonFromLLMResponse(
  content: string | undefined,
  reasoning: string | undefined,
  fallback: string = content ?? ''
): string {
  const candidates = [content, reasoning].filter(Boolean) as string[];

  for (const text of candidates) {
    if (!text) continue;

    // Prefer the whole text as JSON (after stripping markdown fences). This keeps
    // enclosing objects intact when the payload contains nested arrays.
    const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    try {
      JSON.parse(stripped);
      return stripped;
    } catch {
      // Continue to more lenient patterns below
    }

    // Try to extract JSON from markdown code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      const extracted = codeBlockMatch[1].trim();
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        // Continue to other patterns
      }
    }

    // Try to find array pattern directly in content
    const arrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
      try {
        JSON.parse(arrayMatch[0]);
        return arrayMatch[0].trim();
      } catch {
        // Continue to other patterns
      }
    }

    // Try to find JSON object with common properties
    const propertyPatterns = [
      /"questions"\s*:\s*(\[[\s\S]*?\])/,
      /"subtasks"\s*:\s*(\[[\s\S]*?\])/,
      /"terms"\s*:\s*(\[[\s\S]*?\])/,
      /"bestPractices"\s*:\s*(\[[\s\S]*?\])/,
      /"patterns"\s*:\s*(\[[\s\S]*?\])/,
    ];

    for (const pattern of propertyPatterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          JSON.parse(match[1]);
          return match[1].trim();
        } catch {
          // Continue to next pattern
        }
      }
    }

    // Try to parse the entire text as JSON
    try {
      JSON.parse(text);
      return text;
    } catch {
      // Continue to next candidate
    }
  }

  return fallback;
}
