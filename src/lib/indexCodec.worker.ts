import { encodeDocument } from './documentCodec';
self.onmessage = (event: MessageEvent<{ id: number; texts: string[]; markdown?: boolean[] }>) => {
  try {
    const documents = event.data.texts.map((text, i) => encodeDocument(text, event.data.markdown?.[i] ?? true));
    self.postMessage({ id: event.data.id, documents }, { transfer: documents.flatMap(d => [d.bytes.buffer, d.bloom.buffer]) });
  } catch (error) { self.postMessage({ id: event.data.id, error: String(error) }); }
};
