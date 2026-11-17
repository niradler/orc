export interface ComposerBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComposerHandoff {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
}

/** A one-pixel move is a rounding difference, not a position change. */
const MIN_MOVE = 1;
const MIN_SCALE = 0.001;

/**
 * FLIP origin for the hero composer docking. The returned transform is the
 * inverse of the move: applying it to the docked box puts that box where the
 * hero box was, so animating back to `none` reads as one continuous element.
 * A zero delta means nothing moved (a reload, a resize that did not dock it),
 * so it returns null instead of running a no-op animation.
 */
export function composerHandoff(from: ComposerBox, to: ComposerBox): ComposerHandoff | null {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  // A collapsed box on either side cannot say how much to scale; translate only.
  const scaleX = from.width > 0 && to.width > 0 ? from.width / to.width : 1;
  const scaleY = from.height > 0 && to.height > 0 ? from.height / to.height : 1;
  if (
    Math.abs(dx) < MIN_MOVE &&
    Math.abs(dy) < MIN_MOVE &&
    Math.abs(scaleX - 1) < MIN_SCALE &&
    Math.abs(scaleY - 1) < MIN_SCALE
  )
    return null;
  return { dx, dy, scaleX, scaleY };
}

/** Transform for the first keyframe; `transform: none` is the last one. */
export function composerHandoffTransform(handoff: ComposerHandoff): string {
  return `translate(${handoff.dx}px, ${handoff.dy}px) scale(${handoff.scaleX}, ${handoff.scaleY})`;
}
