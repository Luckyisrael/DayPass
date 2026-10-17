/** PayBox tool results are always a JSON string in a text content block. */
export function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
