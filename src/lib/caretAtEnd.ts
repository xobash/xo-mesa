/** WebKit focuses a newly mounted textarea or input with the caret at the
 *  start, so typing right after opening an editor prepended to the value
 *  ("5" + "7" → "75"). Use as `onFocus` on in-place editors. */
export function placeCaretAtEnd(event: { currentTarget: HTMLTextAreaElement | HTMLInputElement }): void {
  const end = event.currentTarget.value.length;
  event.currentTarget.setSelectionRange(end, end);
}
