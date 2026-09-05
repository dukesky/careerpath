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
 * Thrown into the producer by `send` once the client has gone. It unwinds the
 * producer — running the finalizers that abort the upstream model call — and is
 * swallowed at the top: a disconnect is not a failure anyone can be told about.
 */
class ClientGone extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientGone";
  }
}

/**
 * Opens an SSE response and runs `produce`, which pushes frames through `send`.
 * `[DONE]` is appended when it resolves, an error frame when it rejects.
 *
 * A client that hangs up cancels the stream: `send` then throws instead of
 * writing, so the producer unwinds rather than generating (and billing) into a
 * socket nobody is reading.
 */
export function sseResponse(
  produce: (send: SseSend) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  // `cancelled` is set by the stream's own cancel(); `closed` once we are done
  // with the controller. Either makes every later controller call a no-op, so
  // the error path can never fault a second time on a controller that is gone.
  let cancelled = false;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (frame: string) => {
        if (cancelled || closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Belt and braces: the stream went away without our cancel() running.
          closed = true;
        }
      };
      const send: SseSend = (payload) => {
        if (cancelled) throw new ClientGone();
        write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      try {
        await produce(send);
        write("data: [DONE]\n\n");
      } catch (err) {
        if (!(err instanceof ClientGone)) {
          // The headers are long gone by now, so an error is a frame, not a
          // status code. The client reads it and shows the same failure copy it
          // would have shown for a 502.
          const error = err instanceof Error ? err.message : "stream failed";
          write(`data: ${JSON.stringify({ error })}\n\n`);
        }
      } finally {
        const spent = cancelled || closed;
        closed = true;
        if (!spent) {
          try {
            controller.close();
          } catch {
            // Already closed or errored by the runtime; nothing left to do.
          }
        }
      }
    },
    cancel() {
      cancelled = true;
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
 *
 * Stepping by hand also means the generator has no `for await` to close it, so
 * an early exit has to do that here: without the `return()` below, a client
 * disconnect leaves streamLLM suspended at a yield forever and its upstream
 * fetch generating — and billing — with nobody to read the result.
 */
export async function drainDeltas(
  gen: AsyncGenerator<string, string>,
  onDelta: (delta: string) => void,
): Promise<string> {
  let drained = false;
  try {
    let step = await gen.next();
    while (!step.done) {
      onDelta(step.value);
      step = await gen.next();
    }
    drained = true;
    return step.value;
  } finally {
    if (!drained) {
      try {
        await gen.return?.(undefined as never);
      } catch {
        // The generator's own finalizer failed; do not let that mask why we
        // left the loop in the first place.
      }
    }
  }
}
