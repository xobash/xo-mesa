import { useState, type SyntheticEvent } from "react";

/** Plain-language reason for a media element error. */
export function mediaErrorMessage(name: string, ext: string, code: number | undefined): string {
  const format = ext ? ext.toUpperCase() : "this";
  if (code === 2) return `Mesa could not read ${name}. The file may be unavailable or still being written.`;
  if (code === 3) return `${name} could not be decoded. It may be damaged or use a codec this system cannot play.`;
  return `This system's media player cannot play ${format} files like ${name}. The file is unchanged; open it in another app.`;
}

function useMediaError(name: string, ext: string) {
  const [error, setError] = useState<string | null>(null);
  const onError = (event: SyntheticEvent<HTMLMediaElement>) => setError(mediaErrorMessage(name, ext, event.currentTarget.error?.code));
  return { error, onError };
}

/** Audio player that says when the system cannot play the file. */
export function AudioPlayer({ src, name, ext }: { src: string; name: string; ext: string }) {
  const { error, onError } = useMediaError(name, ext);
  if (error) return <div className="media-player-error" role="alert">{error}</div>;
  return (
    <figure className="audio-player">
      <figcaption className="media-name">{name}</figcaption>
      <audio src={src} controls preload="metadata" onError={onError} />
    </figure>
  );
}

/** Video player; a file with no picture (audio-only Ogg) gets the compact audio layout. */
export function VideoPlayer({ src, name, ext, className }: { src: string; name: string; ext: string; className: string }) {
  const { error, onError } = useMediaError(name, ext);
  const [audioOnly, setAudioOnly] = useState(false);
  if (error) return <div className="media-player-error" role="alert">{error}</div>;
  // One stable <video> position, so switching layout never reloads the media.
  return (
    <div className={audioOnly ? "audio-player" : "video-player"}>
      {audioOnly && <div className="media-name">{name}</div>}
      <video
        className={audioOnly ? undefined : className}
        src={src}
        controls
        preload="metadata"
        onError={onError}
        onLoadedMetadata={(e) => setAudioOnly(e.currentTarget.videoWidth === 0 && e.currentTarget.videoHeight === 0)}
      />
    </div>
  );
}
