import { useCallback, useRef, useState, type MutableRefObject } from "react";

/** Status shown when an edit arrives while a save is writing. */
export const SAVE_WAIT = "Mesa is saving. Edit again when the save finishes.";

/**
 * A save-in-progress flag. The ref changes at once, before React renders, so
 * an edit that arrives in that gap is refused instead of being replaced by
 * the saved bytes when the save adopts them.
 */
export function useSaveLock(): [boolean, MutableRefObject<boolean>, (locked: boolean) => void] {
  const [locked, setLocked] = useState(false);
  const ref = useRef(false);
  const set = useCallback((next: boolean) => {
    ref.current = next;
    setLocked(next);
  }, []);
  return [locked, ref, set];
}
