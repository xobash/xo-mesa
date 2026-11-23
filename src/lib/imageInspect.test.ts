import { describe, expect, it } from "vitest";
import { imageEditRefusal, imageEditRefusalForExt, imageOverwriteWarning, inspectImage, IMAGE_EDIT_MAX_PIXELS } from "./imageInspect";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
function pngChunk(type: string, data: number[]): number[] {
  return [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}
function png(width: number, height: number, extra: number[][] = [], depth = 8): Uint8Array {
  const ihdr = pngChunk("IHDR", [...be32(width), ...be32(height), depth, 6, 0, 0, 0]);
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...extra.flat(), ...pngChunk("IDAT", [0]), ...pngChunk("IEND", [])]);
}
function jpeg(width: number, height: number, segments: number[][] = []): Uint8Array {
  const sof = [0xff, 0xc0, 0, 17, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, ...new Array(9).fill(0)];
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...sof, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}
const app = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
function webpVp8x(width: number, height: number, flags: number): Uint8Array {
  const w = width - 1, h = height - 1;
  const data = [flags, 0, 0, 0, w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255];
  const body = [...ascii("WEBP"), ...ascii("VP8X"), ...le32(data.length), ...data];
  return Uint8Array.from([...ascii("RIFF"), ...le32(body.length), ...body]);
}

describe("inspectImage", () => {
  it("reads PNG size, APNG animation, 16-bit depth and metadata chunks", () => {
    expect(inspectImage(png(640, 480))).toMatchObject({ format: "png", width: 640, height: 480, animated: false, metadata: [] });
    expect(inspectImage(png(2, 2, [pngChunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0])])).animated).toBe(true);
    const meta = inspectImage(png(2, 2, [pngChunk("iCCP", [1]), pngChunk("eXIf", [1]), pngChunk("tEXt", [1])], 16));
    expect(meta.highBitDepth).toBe(true);
    expect(meta.metadata).toEqual(["a colour profile (ICC)", "EXIF metadata (camera, date, location)", "text metadata"]);
  });

  it("reads JPEG size after EXIF and ICC segments", () => {
    const info = inspectImage(jpeg(4032, 3024, [app(0xe1, [...ascii("Exif"), 0, 0, 1, 2]), app(0xe2, [...ascii("ICC_PROFILE"), 0, 1])]));
    expect(info).toMatchObject({ format: "jpeg", width: 4032, height: 3024 });
    expect(info.metadata).toEqual(["EXIF metadata (camera, date, location)", "a colour profile (ICC)"]);
  });

  it("reads extended WebP size and its animation flag", () => {
    expect(inspectImage(webpVp8x(1000, 700, 0x08))).toMatchObject({ format: "webp", width: 1000, height: 700, animated: false });
    expect(inspectImage(webpVp8x(10, 10, 0x02)).animated).toBe(true);
  });

  it("stops on truncated or hostile chunk lengths", () => {
    const broken = png(4, 4);
    const truncated = broken.subarray(0, 40);
    expect(inspectImage(truncated)).toMatchObject({ format: "png", width: 4 });
    const hostile = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
    expect(inspectImage(hostile).width).toBe(0);
  });
});

describe("image edit refusals", () => {
  it.each([["svg", "vector"], ["gif", "animated"], ["heic", "PNG, JPEG and WebP"], ["avif", "PNG, JPEG and WebP"]])("refuses %s before reading it", (ext, reason) => {
    expect(imageEditRefusalForExt(ext)).toContain(reason);
  });

  it("refuses animation, mismatched contents and images over the pixel limit", () => {
    expect(imageEditRefusal("png", inspectImage(png(2, 2, [pngChunk("acTL", [0])])))).toContain("animated");
    expect(imageEditRefusal("webp", inspectImage(webpVp8x(10, 10, 0x02)))).toContain("animated");
    expect(imageEditRefusal("png", inspectImage(jpeg(10, 10)))).toContain("not a PNG");
    const side = Math.ceil(Math.sqrt(IMAGE_EDIT_MAX_PIXELS)) + 1;
    expect(imageEditRefusal("jpg", inspectImage(jpeg(side, side)))).toContain("megapixels");
    expect(imageEditRefusal("jpeg", inspectImage(jpeg(4032, 3024)))).toBeNull();
  });

  it("warns about quality loss and names the metadata a save removes", () => {
    const warning = imageOverwriteWarning("photo.jpg", inspectImage(jpeg(10, 10, [app(0xe1, [...ascii("Exif"), 0, 0])])));
    expect(warning).toContain("JPEG re-encoding loses some quality");
    expect(warning).toContain("EXIF metadata");
    expect(warning).toContain("Save as copy");
    expect(imageOverwriteWarning("a.png", inspectImage(png(2, 2, [], 16)))).toContain("8 bits per channel");
  });
});
