// Worker-safe parsing. Output is untrusted until sanitizeHtml runs in the DOM realm.
import MarkdownIt from "markdown-it";
import { IMAGE_EXT, parseFrontmatter } from "./markdownExtract";

const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });

// --- inline rule: wiki links & embeds -------------------------------------
function wikilink(state: any, silent: boolean): boolean {
  const src: string = state.src;
  let pos: number = state.pos;
  let embed = false;

  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    if (src.charCodeAt(pos + 1) !== 0x5b || src.charCodeAt(pos + 2) !== 0x5b) return false;
    embed = true;
    pos += 1;
  }
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;

  const close = src.indexOf("]]", pos + 2);
  if (close < 0) return false;

  const inner = src.slice(pos + 2, close);
  if (inner.length === 0 || inner.indexOf("\n") >= 0) return false;

  if (!silent) {
    const bar = inner.indexOf("|");
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const alias = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();

    if (embed && IMAGE_EXT.test(target)) {
      const token = state.push("wiki_image", "img", 0);
      token.content = target;
      token.meta = { alias };
    } else if (embed) {
      const token = state.push("wiki_embed", "span", 0);
      token.content = target;
      token.meta = { alias };
    } else {
      const token = state.push("wiki_link", "a", 0);
      token.content = target;
      token.meta = { alias };
    }
  }
  state.pos = close + 2;
  return true;
}

md.inline.ruler.before("image", "wikilink", wikilink);

md.renderer.rules.wiki_link = (tokens: any, idx: number): string => {
  const t = tokens[idx];
  const target = md.utils.escapeHtml(t.content);
  const alias = md.utils.escapeHtml(t.meta.alias || t.content);
  return `<a href="#" class="wikilink" data-target="${target}">${alias}</a>`;
};

md.renderer.rules.wiki_image = (tokens: any, idx: number): string => {
  const t = tokens[idx];
  const target = md.utils.escapeHtml(t.content);
  const alias = md.utils.escapeHtml(t.meta.alias || t.content);
  // `src` is filled in by the React layer once the path is resolved.
  return `<img class="md-embed" data-embed="${target}" alt="${alias}" />`;
};

md.renderer.rules.wiki_embed = (tokens: any, idx: number): string => {
  const t = tokens[idx];
  const target = md.utils.escapeHtml(t.content);
  return `<span class="wikilink embed" data-target="${target}">⧉ ${target}</span>`;
};

// Convert task markers during parsing rather than walking every rendered list.
md.core.ruler.after('inline', 'task_checkboxes', (state) => {
  const lists: number[] = [];
  state.tokens.forEach((token, index) => {
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') lists.push(index);
    if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') lists.pop();
    if (token.type !== 'inline' || state.tokens[index - 1]?.type !== 'paragraph_open' ||
      state.tokens[index - 2]?.type !== 'list_item_open') return;
    const first = token.children?.[0];
    const match = first?.type === 'text' ? /^\[( |x|X)\]\s+/.exec(first.content) : null;
    if (!first || !match) return;
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}>`;
    token.children!.unshift(checkbox);
    const list = lists[lists.length - 1];
    if (list !== undefined) state.tokens[list].attrJoin('class', 'task-list');
  });
});

// Transform parsed blockquotes, preserving the document-wide reference environment.
md.core.ruler.after('inline', 'callouts', (state) => {
  const stack: number[] = [];
  state.tokens.forEach((token, index) => {
    if (token.type === 'blockquote_open') stack.push(index);
    if (token.type !== 'blockquote_close') return;
    const opening = stack.pop();
    if (opening === undefined) return;
    const paragraph = state.tokens[opening + 1];
    const inline = state.tokens[opening + 2];
    if (paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') return;
    const match = /^\[!(\w+)\][+-]?([^\n]*)(?:\n|$)/.exec(inline.content);
    if (!match) return;
    const type = match[1].toLowerCase();
    state.tokens[opening].type = 'callout_open';
    state.tokens[opening].meta = { type, title: match[2].trim() || type };
    token.type = 'callout_close';
    inline.content = inline.content.slice(match[0].length);
    inline.children = [];
    md.inline.parse(inline.content, md, state.env, inline.children);
    if (!inline.content) {
      paragraph.hidden = true;
      state.tokens[opening + 3].hidden = true;
    }
  });
});
md.renderer.rules.callout_open = (tokens, index) => {
  const { type, title } = tokens[index].meta;
  return `<div class="callout" data-callout="${md.utils.escapeHtml(type)}"><div class="callout-title">${md.utils.escapeHtml(title)}</div>`;
};
md.renderer.rules.callout_close = () => '</div>\n';

export interface MarkdownBlock { html: string }

// Conservative lexical balance, not an HTML sanitizer. Ambiguous/invalid markup
// stays in one context for the browser and DOMPurify to interpret together.
const VOID_HTML = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
function trackHtml(html: string, stack: string[]): boolean {
  let at = 0;
  while (at < html.length) {
    const start = html.indexOf('<', at);
    if (start < 0) return true;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) return false;
      at = end + 3; continue;
    }
    const match = /^<(\/?)([A-Za-z][\w:-]*)(?=[\s/>])/.exec(html.slice(start));
    if (!match) return false;
    let end = start + match[0].length, quote = '';
    for (; end < html.length; end++) {
      const c = html[end];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (end === html.length) return false;
    const name = match[2].toLowerCase();
    if (match[1]) { if (stack.pop() !== name) return false; }
    else if (!VOID_HTML.has(name)) {
      // XML self-closing syntax on ordinary HTML is not actually self-closing.
      if (name === 'script' || name === 'style' || name === 'textarea' || name === 'title') {
        const close = new RegExp('</' + name + '\\s*>', 'ig');
        close.lastIndex = end + 1;
        const found = close.exec(html);
        if (!found) return false;
        at = close.lastIndex; continue;
      }
      if (/\/\s*>$/.test(html.slice(start, end + 1))) return false;
      stack.push(name);
    }
    at = end + 1;
  }
  return true;
}

/** Parse once with one reference environment. Emit only complete Markdown trees
 * and balanced HTML contexts; raw containers spanning Markdown stay together.
 */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const { body, props } = parseFrontmatter(source ?? '');
  const env = {};
  const tokens = md.parse(body, env);
  const blocks: MarkdownBlock[] = [];
  if (props.length) blocks.push({
    html: '<div class="properties">' + props.map(([k, v]) =>
      `<div class="prop"><span class="prop-key">${md.utils.escapeHtml(k)}</span><span class="prop-val">${md.utils.escapeHtml(v)}</span></div>`).join('') + '</div>'
  });
  let start = 0, depth = 0, valid = true;
  const htmlStack: string[] = [];
  const output: MarkdownBlock[] = [];
  tokens.forEach((token, index) => {
    if (token.type === 'html_block') valid = trackHtml(token.content, htmlStack) && valid;
    if (token.type === 'inline') for (const child of token.children ?? []) {
      if (child.type === 'html_inline') valid = trackHtml(child.content, htmlStack) && valid;
    }
    depth += token.nesting;
    if (depth === 0 && htmlStack.length === 0 && valid) {
      const html = md.renderer.render(tokens.slice(start, index + 1), md.options, env);
      if (html) output.push({ html });
      start = index + 1;
    }
  });
  if (!valid || htmlStack.length || start < tokens.length)
    blocks.push({ html: md.renderer.render(tokens, md.options, env) });
  else blocks.push(...output);
  return blocks;
}

/** Compatibility rendering uses exactly the same parser and block semantics. */
export function parseMarkdown(source: string): string {
  return parseMarkdownBlocks(source).map(block => block.html).join('');
}
