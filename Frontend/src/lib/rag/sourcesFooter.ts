/**
 * Stream transform: appends a "Sources: [S1] …" footer to the model's reply,
 * placed immediately BEFORE the first `<recommendations>` / `<planning>` tag
 * (the client strips everything from those tags onward, so the footer would
 * otherwise be invisible).
 *
 * Streaming stays live: only a small tail is held back so a tag starting at
 * the boundary can still be detected.
 */

const TAG_MARKERS = ["<recommendations>", "<planning>"] as const;
/** Must exceed the longest tag marker by a wide margin. */
const TAIL_HOLD = 400;

function firstTagIndex(text: string): number {
  let best = -1;
  for (const marker of TAG_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

/**
 * Wrap `source` so the emitted text ends with `footer`.
 * If no machine-readable tag appears, the footer is appended at the very end.
 */
export function withSourcesFooter(
  source: ReadableStream<Uint8Array>,
  footer: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = source.getReader();
  let tail = "";
  let inserted = false;

  const finish = (): Uint8Array => {
    const rest = tail + decoder.decode();
    tail = "";
    if (inserted || !footer) return encoder.encode(rest);
    inserted = true;
    const idx = firstTagIndex(rest);
    if (idx !== -1) return encoder.encode(rest.slice(0, idx) + footer + rest.slice(idx));
    return encoder.encode(rest + footer);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(finish());
        controller.close();
        return;
      }

      const text = tail + decoder.decode(value, { stream: true });
      tail = "";

      if (inserted || !footer) {
        controller.enqueue(encoder.encode(text));
        return;
      }

      const idx = firstTagIndex(text);
      if (idx !== -1) {
        inserted = true;
        controller.enqueue(encoder.encode(text.slice(0, idx) + footer + text.slice(idx)));
        return;
      }

      if (text.length > TAIL_HOLD) {
        const emit = text.length - TAIL_HOLD;
        controller.enqueue(encoder.encode(text.slice(0, emit)));
        tail = text.slice(emit);
      } else {
        tail = text;
      }
    },
    async cancel(reason) {
      tail = "";
      await reader.cancel(reason);
    },
  });
}
