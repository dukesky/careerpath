/**
 * Server-sent-events plumbing for the streaming route branches.
 *
 * Transport only. Gating, prompt building and charging stay in the routes, so
 * a streamed request runs the same code as a buffered one right up to the
 * moment the model is called — which is the property the tests lean on.
 *
 * Frame contract (consumed verbatim by the extension):
 *   data: {"d":"<text delta>"}\n\n   repeated
 *   data: {"final":<the buffered response body>}\n\n
 *   data: [DONE]\n\n
 * A failure emits `data: {"error":"<message>"}\n\n` and closes; no [DONE].
 */

export type SseSend = (payload: unknown) => void;

/**
 * Opens an SSE response and runs `produce`, which pushes frames through `send`.
 * `[DONE]` is appended when it resolves, an error frame when it rejects.
 */
export function sseResponse(
  produce: (send: SseSend) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SseSend = (payload) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      try {
        await produce(send);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        // The headers are long gone by now, so an error is a frame, not a
        // status code. The client reads it and shows the same failure copy it
        // would have shown for a 502.
        send({ error: err instanceof Error ? err.message : "stream failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Drains a delta generator, returning its full text.
 *
 * Stepped by hand because the full text is the generator's RETURN value, which
 * a `for await` loop silently discards.
 */
export async function drainDeltas(
  gen: AsyncGenerator<string, string>,
  onDelta: (delta: string) => void,
): Promise<string> {
  let step = await gen.next();
  while (!step.done) {
    onDelta(step.value);
    step = await gen.next();
  }
  return step.value;
}
