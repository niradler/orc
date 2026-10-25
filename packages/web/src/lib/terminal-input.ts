// Phone keyboards (Gboard, SwiftKey, Samsung) type through IME composition: each word is
// held in the textarea until space or a suggestion commits it. Ghostty only sends text on
// compositionend, so nothing reached the shell until the word ended, and when the commit
// arrived through both compositionend and a follow-up input it was sent twice ("gogo").
//
// The hidden textarea is therefore the single source of truth: every edit, composed or
// not, is mirrored to the PTY as the difference from what was already sent - new
// characters are typed and replaced ones are erased with backspaces.

const BACKSPACE = "\x7f";
// Bound the mirrored text so a long session does not keep growing the textarea.
const MAX_MIRROR = 256;

const KEYED_EDITS = new Set(["Enter", "Backspace", "Delete"]);

/** The key a native edit corresponds to, to recognise one ghostty already sent at keydown. */
function keyFor(event: InputEvent): string | null {
  if (event.inputType === "insertText") return event.data;
  if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph")
    return "Enter";
  if (event.inputType === "deleteContentBackward") return "Backspace";
  if (event.inputType === "deleteContentForward") return "Delete";
  return null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Keys that turn the already-sent `before` into `after`: erase the diverging tail, type the new one. */
export function textDelta(before: string, after: string): string {
  let common = 0;
  const limit = Math.min(before.length, after.length);
  while (common < limit && before[common] === after[common]) common++;
  // Never split a surrogate pair: an emoji is erased with one backspace, not half of one.
  if (common > 0 && isHighSurrogate(before.charCodeAt(common - 1))) common--;
  const erased = [...before.slice(common)].length;
  return BACKSPACE.repeat(erased) + after.slice(common).replace(/\r?\n/g, "\r");
}

/** Ctrl+key for a typed character, or null when it has no control code. */
export function controlCode(char: string): string | null {
  if (char === " ") return "\x00";
  const code = char.toUpperCase().charCodeAt(0);
  return char.length === 1 && code >= 0x40 && code <= 0x5f
    ? String.fromCharCode(code & 0x1f)
    : null;
}

export interface TerminalTextInput {
  /** Input reached the shell another way (key bar, paste), so the keyboard's line is stale. */
  reset(): void;
  /** Send the next typed character as Ctrl+character; `onUsed` fires once it is consumed. */
  armCtrl(onUsed: (() => void) | null): void;
}

export function attachTerminalTextInput(
  element: HTMLElement,
  send: (data: string) => void,
): TerminalTextInput | null {
  const textarea = element.querySelector("textarea");
  if (!textarea) return null;
  textarea.inputMode = "text";
  textarea.enterKeyHint = "enter";
  textarea.setAttribute("autocomplete", "off");
  textarea.style.fontSize = "16px";
  let sent = "";
  let composing = false;
  let staleLine = false;
  let typedByKey: string | null = null;
  let ctrl: (() => void) | null = null;

  const clear = () => {
    textarea.value = "";
    sent = "";
    staleLine = false;
  };
  // Rewriting the textarea mid-word would make the keyboard commit the word again.
  const reset = () => {
    if (composing) staleLine = true;
    else clear();
  };
  const takeCtrl = (char: string): string | null => {
    const code = ctrl && controlCode(char);
    if (!code) return null;
    const onUsed = ctrl;
    ctrl = null;
    onUsed?.();
    return code;
  };
  const sync = () => {
    const value = textarea.value;
    let delta = textDelta(sent, value);
    const first = delta[0];
    const code = first && first !== BACKSPACE ? takeCtrl(first) : null;
    if (code) {
      delta = code + delta.slice(1);
      staleLine = true;
    }
    sent = value;
    if (delta) send(delta);
    if (!composing && (staleLine || value.length > MAX_MIRROR)) clear();
  };
  textarea.addEventListener("beforeinput", (event) => {
    // Ghostty cancels every beforeinput on its root; let the textarea edit natively and
    // mirror the result on input instead.
    event.stopPropagation();
    const keyed = typedByKey;
    typedByKey = null;
    if (event.isComposing || composing) return;
    // Ghostty already typed this character from its keydown; Android keyboards insert it
    // anyway because they ignore keydown preventDefault.
    if (keyed !== null && keyed === keyFor(event)) {
      event.preventDefault();
      return;
    }
    if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      event.preventDefault();
      sync();
      send("\r");
      // A new line starts a new edit; the keyboard must not rewrite the submitted one.
      clear();
      return;
    }
    // An empty textarea has nothing to delete, so no input event would follow.
    if (event.inputType === "deleteContentBackward" && textarea.value === "") {
      event.preventDefault();
      send(BACKSPACE);
      return;
    }
    if (
      event.inputType === "deleteContentForward" &&
      textarea.selectionStart === textarea.value.length
    ) {
      event.preventDefault();
      send("\x1b[3~");
    }
  });
  textarea.addEventListener("input", sync);
  textarea.addEventListener("compositionstart", () => {
    composing = true;
  });
  textarea.addEventListener("compositionend", (event) => {
    // Ghostty's own handler must still run to clear its composing flag (otherwise it drops
    // every later keydown), but it would send the committed word a second time.
    Object.defineProperty(event, "data", { value: "" });
    composing = false;
    sync();
  });
  // Text typed elsewhere (special-key bar, paste, physical keys) moves the shell cursor,
  // so the keyboard's view of the line is no longer what the shell has.
  textarea.addEventListener("blur", reset);
  textarea.addEventListener("keydown", (event) => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    clear();
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const code = plain ? takeCtrl(event.key) : null;
    if (code) {
      // Ghostty listens on the terminal root; keep it from also typing the plain key.
      event.preventDefault();
      event.stopPropagation();
      send(code);
      return;
    }
    typedByKey = plain && (event.key.length === 1 || KEYED_EDITS.has(event.key)) ? event.key : null;
  });
  return {
    reset,
    armCtrl(onUsed) {
      ctrl = onUsed;
    },
  };
}
