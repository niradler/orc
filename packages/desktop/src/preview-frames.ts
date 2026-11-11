import type { BrowserAction } from "@orc/core/desktop-preview";
import type { WebContents, WebFrameMain } from "electron";
import { z } from "zod";

const snapshotSchema = z.object({
  untrusted: z.literal(true),
  url: z.string().max(1000),
  title: z.string().max(100),
  text: z.string().max(12000),
  truncated: z.boolean(),
  elements: z
    .array(
      z.object({
        ref: z.string().max(100),
        tag: z.string().max(64),
        role: z.string().max(100).nullable(),
        name: z.string().max(120),
        type: z.string().max(64).nullable(),
        disabled: z.boolean(),
      }),
    )
    .max(80),
});

/** Frames are enumerated only beneath the owned guest, never through a global target lookup. */
export class PreviewFrames {
  private selected: string | null = null;
  private readonly refs = new Map<string, string>();
  constructor(private readonly contents: WebContents) {}
  private id(frame: WebFrameMain): string {
    return `${frame.processId}:${frame.routingId}`;
  }
  list(): { frame_id: string; url: string; name: string; main: boolean }[] {
    return this.contents.mainFrame.framesInSubtree
      .filter((frame) => !frame.detached)
      .slice(0, 32)
      .map((frame) => ({
        frame_id: this.id(frame),
        url: frame.url.slice(0, 500),
        name: frame.name.slice(0, 80),
        main: frame === this.contents.mainFrame,
      }));
  }
  select(id: string | null): void {
    if (id !== null) this.frame(id);
    this.selected = id;
  }
  private frame(id: string): WebFrameMain {
    const frame = this.contents.mainFrame.framesInSubtree.find(
      (frame) => !frame.detached && this.id(frame) === id,
    );
    if (!frame)
      throw new Error("Frame was replaced or closed. List frames and take a fresh snapshot.");
    return frame;
  }
  private target(command: object): WebFrameMain {
    const selector = "selector" in command ? command.selector : null;
    const ref = typeof selector === "string" && selector.startsWith("@") ? selector : null;
    const id = ref ? this.refs.get(ref) : this.selected;
    if (ref && !id) throw new Error("Stale browser ref. Take a fresh snapshot.");
    return id ? this.frame(id) : this.contents.mainFrame;
  }
  private async offset(
    frame: WebFrameMain,
    point?: { x: number; y: number },
  ): Promise<{ x: number; y: number }> {
    let x = 0,
      y = 0,
      current = frame;
    while (current.parent) {
      const parent = current.parent,
        index = parent.frames.indexOf(current);
      if (index < 0) throw new Error("Frame changed while locating its viewport");
      const offset = await parent.executeJavaScript(
        `(()=>{const child=window.frames[${index}];const element=[...document.querySelectorAll('iframe,frame')].find(element=>element.contentWindow===child);if(!element)throw new Error('Frame viewport unavailable');const rect=element.getBoundingClientRect();if(getComputedStyle(element).transform!=='none'||Math.abs(rect.width-element.offsetWidth)>2||Math.abs(rect.height-element.offsetHeight)>2)throw new Error('Transformed frames require a normal viewport before pointer actions');const point=${JSON.stringify(point ? { x: point.x + x, y: point.y + y } : null)};if(point){const hit=document.elementFromPoint(rect.x+element.clientLeft+point.x,rect.y+element.clientTop+point.y);if(hit!==element||getComputedStyle(element).visibility==='hidden')throw new Error('Frame is hidden or covered');}return {x:rect.x+element.clientLeft,y:rect.y+element.clientTop};})()`,
      );
      const displacement = z
        .object({ x: z.number().finite(), y: z.number().finite() })
        .parse(offset);
      x += displacement.x;
      y += displacement.y;
      current = parent;
    }
    return { x, y };
  }
  private async execute(frame: WebFrameMain, code: string): Promise<unknown> {
    if (frame === this.contents.mainFrame)
      return this.contents.executeJavaScriptInIsolatedWorld(999, [{ code }], true);
    return frame.executeJavaScript(code, true);
  }
  async evaluate(expression: string): Promise<unknown> {
    const frame = this.selected ? this.frame(this.selected) : this.contents.mainFrame;
    return frame.executeJavaScript(
      `Promise.resolve().then(()=>(${expression})).then(value=>{const text=JSON.stringify(value??null);if(text.length>64000)throw new Error('Evaluation result exceeds limit');return JSON.parse(text);})`,
      true,
    );
  }
  async run(script: string, command: object): Promise<unknown> {
    const frame = this.target(command);
    if (
      frame !== this.contents.mainFrame &&
      "action" in command &&
      ["click", "type", "prepare_type", "select", "upload"].includes(String(command.action))
    ) {
      const point = z
        .object({ x: z.number().finite(), y: z.number().finite() })
        .parse(
          await this.execute(
            frame,
            `(${script})(${JSON.stringify({ ...command, action: "point" })})`,
          ),
        );
      await this.offset(frame, point);
    }
    const input =
      "action" in command && command.action === "snapshot"
        ? {
            ...command,
            max_chars: Math.max(
              200,
              Number("max_chars" in command ? (command.max_chars ?? 12000) : 12000) - 150,
            ),
          }
        : command;
    const result = await this.execute(frame, `(${script})(${JSON.stringify(input)})`);
    if (
      "action" in command &&
      command.action === "snapshot" &&
      result &&
      typeof result === "object" &&
      "elements" in result &&
      Array.isArray(result.elements)
    ) {
      const snapshot = snapshotSchema.parse(result);
      if (this.refs.size > 2000) this.refs.clear();
      for (const element of snapshot.elements)
        if (typeof element?.ref === "string") this.refs.set(element.ref, this.id(frame));
      return { ...snapshot, frame_id: this.id(frame) };
    }
    if ("action" in command && command.action === "point" && frame !== this.contents.mainFrame) {
      const point = result as { x: number; y: number };
      const offset = await this.offset(frame, point);
      return { x: Math.round(point.x + offset.x), y: Math.round(point.y + offset.y) };
    }
    return result;
  }
  async snapshot(
    script: string,
    command: Extract<BrowserAction, { action: "snapshot" }>,
  ): Promise<unknown> {
    if (this.refs.size > 2000) this.refs.clear();
    if (this.selected || command.selector) return this.run(script, command);
    const frames = this.contents.mainFrame.framesInSubtree
      .filter((frame) => !frame.detached)
      .slice(0, 32);
    const limit = command.max_chars ?? 12000,
      budget = Math.max(400, Math.floor(limit / Math.max(1, frames.length)) - 200);
    const snapshots: Record<string, unknown>[] = [];
    for (const frame of frames) {
      const raw = await this.execute(
        frame,
        `(${script})(${JSON.stringify({ ...command, max_chars: budget })})`,
      );
      const result = snapshotSchema.parse(raw);
      for (const element of result.elements)
        if (typeof element?.ref === "string") this.refs.set(element.ref, this.id(frame));
      snapshots.push({ ...result, frame_id: this.id(frame), name: frame.name.slice(0, 160) });
    }
    const result = { untrusted: true, frames: snapshots, truncated: false };
    while (JSON.stringify(result).length > limit && result.frames.length > 1) {
      result.frames.pop();
      result.truncated = true;
    }
    const first = result.frames[0];
    if (first)
      while (JSON.stringify(result).length > limit) {
        result.truncated = true;
        if (Array.isArray(first.elements) && first.elements.length) first.elements.pop();
        else if (typeof first.text === "string" && first.text.length)
          first.text = first.text.slice(
            0,
            Math.max(0, first.text.length - (JSON.stringify(result).length - limit) - 16),
          );
        else break;
      }
    return result;
  }
}
