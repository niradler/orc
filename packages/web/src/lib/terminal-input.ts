// Phone keyboards commonly emit beforeinput without a usable keydown. Ghostty
// handles physical keys and compositionend, but cancels beforeinput on its root.
export function attachTerminalTextInput(element: HTMLElement, send: (data: string) => void): void {
  const textarea = element.querySelector("textarea");
  if (!textarea) return;
  textarea.inputMode = "text";
  textarea.style.fontSize = "16px";
  textarea.addEventListener("beforeinput", (event) => {
    // Keep native IME edits away from Ghostty's blanket cancellation. Its
    // compositionend handler sends the committed text exactly once.
    event.stopPropagation();
    if (event.isComposing || event.inputType === "insertCompositionText") return;
    const data =
      event.inputType === "insertText" || event.inputType === "insertReplacementText"
        ? event.data
        : event.inputType === "deleteContentBackward"
          ? "\x7f"
          : event.inputType === "deleteContentForward"
            ? "\x1b[3~"
            : event.inputType === "insertLineBreak" || event.inputType === "insertParagraph"
              ? "\r"
              : null;
    if (data === null) return;
    event.preventDefault();
    send(data);
    textarea.value = "";
  });
  textarea.addEventListener("input", (event) => {
    if (!(event instanceof InputEvent) || !event.isComposing) textarea.value = "";
  });
}
