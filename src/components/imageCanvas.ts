import type { ImagePlan } from "../lib/imageEditOps";
import { composeMatrix } from "../lib/imageEditOps";
import { inspectImage, type EditableImageFormat } from "../lib/imageInspect";

/** Draw the planned result from the original pixels in one pass. */
export function drawImagePlan(canvas: HTMLCanvasElement, source: CanvasImageSource, plan: ImagePlan, scale = 1): void {
  canvas.width = Math.max(1, Math.round(plan.width * scale));
  canvas.height = Math.max(1, Math.round(plan.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This system could not create an image canvas.");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = plan.scaled || scale !== 1;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(...composeMatrix([scale, 0, 0, scale, 0, 0], plan.matrix));
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const QUALITY = 0.92;

/** Encode a canvas, refusing a silent format substitution (an engine that
 *  cannot encode WebP returns PNG instead) or a result of the wrong size. */
export async function encodeCanvas(canvas: HTMLCanvasElement, format: EditableImageFormat): Promise<Uint8Array> {
  const mime = `image/${format}`;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, QUALITY));
  if (!blob) throw new Error("This system could not encode the image.");
  if (blob.type !== mime) throw new Error(`This system cannot write ${format.toUpperCase()} images.`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertEncoded(bytes, format, canvas.width, canvas.height);
  return bytes;
}

/** Header check of encoded bytes: right format and size. */
export function assertEncoded(bytes: Uint8Array, format: EditableImageFormat, width: number, height: number): void {
  const info = inspectImage(bytes);
  if (info.format !== format || info.width !== width || info.height !== height) {
    throw new Error("The encoded image did not match the edit; nothing was saved.");
  }
}

/** Decode bytes the way the viewer shows them (EXIF orientation applied). */
export async function decodeImage(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
