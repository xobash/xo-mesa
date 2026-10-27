import { parseMarkdownBlocks } from './markdownParser';
self.onmessage = (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  try { self.postMessage({ id, blocks: parseMarkdownBlocks(source) }); }
  catch (error) { self.postMessage({ id, error: String(error) }); }
};
