import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { readDocumentBytes } from "../lib/documentBytesSave";
import { isCfb } from "../lib/cfb";
import { createOfficeCryptoClient, type OfficeCryptoClient } from "../lib/officeCrypto/client";
import { inspectOfficeProtection, WrongPasswordError } from "../lib/officeCrypto/encryptedOffice";
import type { VaultFile } from "../types";
import { FileFallbackView } from "./FileFallbackView";
import { Modal } from "./Modal";
import { encryptedSource, OfficeByteSourceContext, PLAIN_SOURCE, primedSource, type OfficeByteSource } from "./officeByteSource";

/** Wrong passwords allowed per prompt; closing and reopening the file starts again (no lockout). */
export const MAX_PASSWORD_ATTEMPTS = 20;

type Gate =
  | { phase: "checking" }
  | { phase: "open"; source: OfficeByteSource; encrypted: boolean }
  | { phase: "unsupported"; reason: string }
  | { phase: "locked"; encrypted: Uint8Array; readOnlyReason: string | null; prompt: boolean };

export type CryptoClientFactory = () => OfficeCryptoClient;

/**
 * Opens a Word, Excel or PowerPoint file. A password-protected package
 * (MS-OFFCRYPTO) asks for the password, then the editor works on the
 * decrypted package through `OfficeByteSourceContext`. The password stays in
 * the decryption worker of this open file only and is dropped on close.
 */
export function EncryptedOfficeGate({ file, children, createClient = createOfficeCryptoClient }: {
  file: VaultFile | undefined;
  children: ReactNode;
  createClient?: CryptoClientFactory;
}) {
  const path = file?.path;
  const [gate, setGate] = useState<Gate>({ phase: "checking" });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const clientRef = useRef<OfficeCryptoClient | null>(null);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setGate({ phase: "checking" });
    setAttempts(0);
    setError("");
    readDocumentBytes(path).then((bytes) => {
      if (!alive) return;
      const protection = isCfb(bytes) ? inspectOfficeProtection(bytes) : { kind: "none" as const };
      if (protection.kind === "none") setGate({ phase: "open", source: primedSource(path, bytes), encrypted: false });
      else if (protection.kind === "unsupported") setGate({ phase: "unsupported", reason: protection.reason });
      else setGate({ phase: "locked", encrypted: bytes, readOnlyReason: protection.readOnlyReason, prompt: true });
    }, () => {
      // Let the editor report the read failure in its own words.
      if (alive) setGate({ phase: "open", source: PLAIN_SOURCE, encrypted: false });
    });
    return () => {
      alive = false;
      clientRef.current?.dispose();
      clientRef.current = null;
      setPassword("");
    };
  }, [path]);

  if (!file || !path || gate.phase === "checking") return gate.phase === "checking" && file ? <div className="editor-empty">Opening…</div> : <>{children}</>;
  if (gate.phase === "open") {
    return (
      <OfficeByteSourceContext.Provider value={gate.source}>
        <div className="office-gate">
        {gate.encrypted && (
          <div className="rtf-notice word-notice" role="note">
            Password-protected. Mesa keeps the password in memory only while this file is open and saves it encrypted again.
            {gate.source.readOnlyReason ? ` ${gate.source.readOnlyReason}` : ""}
          </div>
        )}
        {children}
        </div>
      </OfficeByteSourceContext.Provider>
    );
  }
  if (gate.phase === "unsupported") return <FileFallbackView file={file} notice={gate.reason} />;

  const locked = gate;
  const exhausted = attempts >= MAX_PASSWORD_ATTEMPTS;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !password || exhausted) return;
    const typed = password;
    setPassword("");
    setBusy(true);
    setError("");
    const client = clientRef.current ?? createClient();
    clientRef.current = client;
    try {
      const plain = await client.unlock(locked.encrypted, typed);
      if (clientRef.current !== client) return;
      setGate({ phase: "open", encrypted: true, source: encryptedSource(path, client, { encrypted: locked.encrypted, plain }, locked.readOnlyReason) });
    } catch (failure) {
      if (clientRef.current !== client) return;
      if (failure instanceof WrongPasswordError) {
        setAttempts((n) => n + 1);
        setError("That password is not correct. Passwords are case-sensitive.");
      } else {
        setError(`Mesa cannot open this file: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (busy) { clientRef.current?.dispose(); clientRef.current = null; setBusy(false); }
    setPassword("");
    setGate({ ...locked, prompt: false });
  };

  return (
    <div className="office-gate">
      <div className="rtf-notice word-notice" role="note">
        This file is password-protected. <button type="button" className="btn" onClick={() => { setError(""); setGate({ ...locked, prompt: true }); }}>Enter password</button>
      </div>
      <FileFallbackView file={file} notice="it is password-protected. Choose Enter password to open it." />
      {locked.prompt && (
        <Modal title="Password-protected file" onClose={cancel}>
          <form onSubmit={(e) => void submit(e)}>
            <div className="modal-head">This file is password-protected</div>
            <div className="modal-body">
              <p>Enter the password for {file.name}. Mesa keeps it in memory only while this file is open and never stores it.</p>
              <input className="text-input" type="password" aria-label="Password" autoComplete="off" autoFocus
                value={password} disabled={busy || exhausted} onChange={(e) => setPassword(e.target.value)} />
              {error && <p className="file-details-warning" role="alert">{error}</p>}
              {exhausted && <p className="file-details-warning" role="alert">Too many attempts. Close this file and open it again to retry.</p>}
              <button type="submit" className="btn primary" disabled={busy || !password || exhausted}>{busy ? "Checking…" : "Open"}</button>
              <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
