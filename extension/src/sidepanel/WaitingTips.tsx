import { useEffect, useRef, useState } from "react";
import { TIPS, TIP_CATEGORY_LABEL } from "./tips";

/**
 * How long one tip stays on screen.
 *
 * Long enough to read a two-line sentence without hurrying, short enough that
 * the card is visibly alive rather than a static banner. Exported so the test
 * drives the clock by the real value instead of restating it — a rotation
 * that got quietly faster would otherwise pass.
 */
export const TIP_ROTATION_MS = 8000;

/** Fisher-Yates over indices. Pure apart from Math.random. */
function shuffled(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * The card that fills the part of a run with nothing to show yet.
 *
 * Display only. It reads no run state beyond the single boolean above it, it
 * cannot delay anything, and it unmounts the instant real content arrives —
 * see Results.tsx for what counts as "real content" and why the streamed
 * score counts.
 *
 * Two properties are worth more than they look:
 *
 * - The order is SHUFFLED per deck rather than sequential, so a user who runs
 *   the extension five times in a row does not read the same first three tips
 *   five times. It is reshuffled only when the deck is exhausted, which is
 *   what makes "no repeat until you have seen them all" true.
 * - The interval is torn down on unmount AND when `active` goes false. The
 *   card lives inside a component that re-renders on every streaming patch —
 *   several times a second at the peak — so a leaked interval here would
 *   accumulate one timer per run.
 */
export function WaitingTips({ active }: { active: boolean }) {
  const [shownCount, setShownCount] = useState(0);
  // The deck currently being dealt, and which pass through it we are on.
  // Held in refs because neither is rendered directly: they only decide WHICH
  // tip `shownCount` names, so changing them must not itself cause a render.
  // Lazily initialised: `useRef(shuffled(...))` would re-shuffle on EVERY
  // render and throw the result away, and this component re-renders several
  // times a second while a run streams.
  const deck = useRef<number[] | null>(null);
  if (deck.current === null) deck.current = shuffled(TIPS.length);
  const dealt = useRef(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setShownCount((n) => n + 1), TIP_ROTATION_MS);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  // A new pass over the deck gets a new shuffle. Done during render rather
  // than in an effect so the tip painted for this `shownCount` is the one the
  // freshly shuffled deck names — an effect would paint the old deck's card
  // first and correct it a frame later, which reads as a flicker.
  const pass = Math.floor(shownCount / TIPS.length);
  if (pass !== dealt.current) {
    dealt.current = pass;
    deck.current = shuffled(TIPS.length);
  }
  const tip = TIPS[deck.current[shownCount % TIPS.length]];

  return (
    <section className="card tip-card">
      <div className="row">
        <div className="label">While you wait</div>
        <span className="tip-tag">{TIP_CATEGORY_LABEL[tip.category]}</span>
      </div>
      {/* Keyed on the counter so each tip is a NEW node: that is what restarts
          the fade, and it is why the animation is on this element rather than
          on the card, which never remounts. */}
      <p className="tip-text" key={shownCount}>
        <span aria-hidden="true">💡</span> {tip.text}
      </p>
    </section>
  );
}
