import type { ViewerAction, ViewerState } from "./viewer-policy.js";

declare const window: Window & {
  orcViewer: {
    action(action: ViewerAction | "state", value?: string): Promise<ViewerState | undefined>;
    onState(listener: (state: ViewerState) => void): void;
  };
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing viewer control: ${id}`);
  return found as T;
}

const address = element<HTMLInputElement>("address");
function render(state: ViewerState): void {
  if (document.activeElement !== address) address.value = state.url;
  element<HTMLButtonElement>("back").disabled = !state.back;
  element<HTMLButtonElement>("forward").disabled = !state.forward;
  element<HTMLButtonElement>("reload").disabled = !state.url;
  element<HTMLButtonElement>("external").disabled = !state.url;
  element("browser").setAttribute("aria-pressed", String(state.mode === "browser"));
  element("filename").textContent =
    state.mode === "browser" ? "" : (state.file?.name ?? state.image?.name ?? "");
  element("status").textContent = state.error || (state.loading ? "Loading…" : "");
  element("empty").hidden = state.mode !== "browser" || !!state.url;
  const image = element<HTMLImageElement>("image");
  image.hidden = state.mode !== "image";
  image.alt = state.image?.name ?? "";
  if (state.image && image.src !== state.image.url) image.src = state.image.url;
  if (!state.image) image.removeAttribute("src");
  const content = element<HTMLTextAreaElement>("content");
  content.hidden = state.mode !== "file";
  if (content.value !== (state.file?.content ?? "")) content.value = state.file?.content ?? "";
}
async function act(action: ViewerAction, value?: string): Promise<void> {
  try {
    await window.orcViewer.action(action, value);
  } catch {
    element("status").textContent = "The viewer could not complete this action. Please retry.";
  }
}
for (const action of ["browser", "file", "back", "forward", "reload", "external"] as const) {
  element(action).addEventListener("click", () => void act(action));
}
element("navigation").addEventListener("submit", (event) => {
  event.preventDefault();
  void act("navigate", address.value.trim());
  address.blur();
});
window.orcViewer.onState(render);
void window.orcViewer.action("state").then((state) => {
  if (state) render(state);
});
