// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { AudioPlayer, VideoPlayer, mediaErrorMessage } from "./MediaPlayer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.replaceChildren(); });

it("plays audio with native controls and replaces a dead player with a reason", () => {
  root = createRoot(host);
  act(() => root.render(<AudioPlayer src="asset://localhost/v/song.flac" name="song.flac" ext="flac" />));
  const audio = host.querySelector("audio")!;
  expect(audio.controls).toBe(true);
  expect(audio.getAttribute("src")).toBe("asset://localhost/v/song.flac");
  act(() => { audio.dispatchEvent(new Event("error")); });
  expect(host.querySelector("audio")).toBeNull();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("cannot play FLAC files like song.flac");
});

it("switches an audio-only Ogg file to the compact layout without reloading it", () => {
  root = createRoot(host);
  act(() => root.render(<VideoPlayer className="media-el" src="asset://x/a.ogg" name="a.ogg" ext="ogg" />));
  const video = host.querySelector("video")!;
  expect(video.className).toBe("media-el");
  Object.defineProperty(video, "videoWidth", { value: 0 });
  Object.defineProperty(video, "videoHeight", { value: 0 });
  act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
  expect(host.querySelector(".audio-player video")).toBe(video);
  expect(host.textContent).toContain("a.ogg");
});

it("distinguishes unreadable, undecodable and unsupported media", () => {
  expect(mediaErrorMessage("a.mp3", "mp3", 2)).toContain("could not read");
  expect(mediaErrorMessage("a.mp3", "mp3", 3)).toContain("could not be decoded");
  expect(mediaErrorMessage("a.opus", "opus", 4)).toContain("cannot play OPUS");
});
