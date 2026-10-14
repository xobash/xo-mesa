import { useRef, useState } from "react";

type Props = { src: string; alt: string; className?: string; loading?: "lazy" | "eager" };

/** Keep decode failures local to the image that failed. */
export function VaultImage(props: Props) {
  return <ImageAttempt key={props.src} {...props} />;
}

function ImageAttempt({ src, alt, className, loading }: Props) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Retry unmounts its own button; give focus to the new one if it fails again.
  const refocus = useRef(false);
  if (failed) return (
    <span className="vault-image-error" role="status">
      <span>Cannot load image: {alt}.</span>
      <span>The file may be incomplete, unsupported, or unavailable.</span>
      <button className="btn" type="button" ref={(button) => {
        if (button && refocus.current) { refocus.current = false; button.focus(); }
      }} onClick={(event) => {
        event.stopPropagation();
        refocus.current = event.currentTarget === document.activeElement;
        setAttempt(value => value + 1);
        setFailed(false);
      }}>Retry image</button>
    </span>
  );
  return <img key={attempt} className={className} src={src} alt={alt} loading={loading}
    onLoad={() => { refocus.current = false; }} onError={() => setFailed(true)} />;
}
