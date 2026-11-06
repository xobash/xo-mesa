import { useEffect, useState } from "react";
import { currentDevicePixelRatio, onDevicePixelRatioChange } from "../lib/devicePixelRatio";

/** The live device pixel ratio; the component re-renders when it changes. */
export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(currentDevicePixelRatio);
  useEffect(() => {
    // The ratio can change between the first render and this effect.
    setRatio(currentDevicePixelRatio());
    return onDevicePixelRatioChange(setRatio);
  }, []);
  return ratio;
}
