/** agy Gemini model variants already encode their required reasoning effort. */
export function fixedGeminiEffort(model: string): string | null {
  return /^gemini-.*-(low|medium|high)$/i.exec(model)?.[1]?.toLowerCase() ?? null;
}
