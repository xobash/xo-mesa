import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { ByteSource, memoryRangeReader } from "./byteSource";
import { listZipArchive } from "./zipView";
import { ODF_ENCRYPTED_REASON, odfEncryptionReason } from "./odfEncryption";

const manifest = (encrypted: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml" manifest:size="1234">${encrypted
    ? `<manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AAAA"><manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AAAA"/></manifest:encryption-data>`
    : ""}</manifest:file-entry>
</manifest:manifest>`;

async function reasonFor(ext: string, encrypted: boolean) {
  const zip = zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.text"), "content.xml": new Uint8Array([1, 2, 3]), "META-INF/manifest.xml": strToU8(manifest(encrypted)) });
  const source = await ByteSource.open(memoryRangeReader(zip));
  return odfEncryptionReason(ext, source, await listZipArchive(source));
}

describe("encrypted OpenDocument files", () => {
  it("names a password-protected ODF package as read-only with the reason", async () => {
    expect(await reasonFor("odt", true)).toBe(ODF_ENCRYPTED_REASON);
    expect(await reasonFor("ODS", true)).toBe(ODF_ENCRYPTED_REASON);
  });

  it("says nothing for plain ODF packages or other archives", async () => {
    expect(await reasonFor("odt", false)).toBeNull();
    expect(await reasonFor("zip", true)).toBeNull();
  });
});
