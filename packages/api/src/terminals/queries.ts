// Terminal emulators answer capability queries that shells and TUIs print (prompt frameworks,
// fish, neovim, crossterm apps). The browser renderer can't see those, and on macOS/Linux the
// kernel PTY doesn't answer either, so the server replies from here. ConPTY on Windows already
// answers device attributes itself, so that part is switched off there to avoid double replies.

// Keep in sync with TERMINAL_THEME in packages/web/src/lib/terminal-runtime.ts.
const BACKGROUND = "#090e1a";
const FOREGROUND = "#e1e5f6";

const DEVICE_ATTRIBUTES = "\x1b[?62;22c";
const SECONDARY_ATTRIBUTES = "\x1b[>1;10;0c";
const VERSION = "\x1bP>|orc\x1b\\";

// CSI c / CSI > c / CSI > q, and OSC 10 / 11 ";?" colour queries ended by BEL or ST.
const ESC = "\x1b";
const BEL = "\x07";
const QUERY = new RegExp(`${ESC}(?:\\[(0?c|>0?c|>0?q)|\\](1[01]);\\?(${BEL}|${ESC}\\\\))`, "g");
const MAX_PARTIAL = 12;

function oscColor(slot: string, hex: string, terminator: string): string {
  const channel = (offset: number) => {
    const byte = hex.slice(1 + offset, 3 + offset);
    return byte + byte;
  };
  return `\x1b]${slot};rgb:${channel(0)}/${channel(2)}/${channel(4)}${terminator}`;
}

// The tail that the next chunk may complete into a query: an unfinished CSI/OSC introducer, or a
// lone trailing ESC (the start of one, or the first half of an "ESC \" terminator whose OSC
// introducer is earlier in the same tail).
function openTail(text: string, consumed: number): string {
  const introducer = Math.max(text.lastIndexOf(`${ESC}[`), text.lastIndexOf(`${ESC}]`));
  const trailing = text.endsWith(ESC) ? text.length - 1 : -1;
  for (const start of [introducer, trailing].sort((a, b) => a - b)) {
    if (start >= consumed && text.length - start < MAX_PARTIAL) return text.slice(start);
  }
  return "";
}

export interface QueryResponderOptions {
  answerDeviceAttributes: boolean;
}

export class TerminalQueryResponder {
  private partial = "";

  constructor(private readonly options: QueryResponderOptions) {}

  feed(chunk: Uint8Array): string[] {
    const text = this.partial + Buffer.from(chunk).toString("latin1");
    const replies: string[] = [];
    let consumed = 0;
    for (const match of text.matchAll(QUERY)) {
      consumed = match.index + match[0].length;
      const reply = this.reply(match[1], match[2], match[3]);
      if (reply) replies.push(reply);
    }
    this.partial = openTail(text, consumed);
    return replies;
  }

  private reply(csi: string | undefined, osc: string | undefined, terminator = ""): string | null {
    if (osc) return oscColor(osc, osc === "10" ? FOREGROUND : BACKGROUND, terminator);
    if (csi === ">0q" || csi === ">q") return VERSION;
    if (!this.options.answerDeviceAttributes) return null;
    return csi?.startsWith(">") ? SECONDARY_ATTRIBUTES : DEVICE_ATTRIBUTES;
  }
}
