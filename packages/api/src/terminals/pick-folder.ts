import { ValidationError } from "@orc/core/errors";

export interface FolderPickerRequest {
  platform: NodeJS.Platform;
  which: (command: string) => string | null;
  initial: string | undefined;
}

export interface FolderPickerLaunch {
  argv: string[];
  env: Record<string, string>;
}

// The start folder reaches the dialog through this env var so a path is never parsed as script.
const INITIAL_ENV = "ORC_PICK_INITIAL";

// Windows PowerShell 5.1 runs on .NET Framework, whose FolderBrowserDialog has no
// AutoUpgradeEnabled and shows the old tree view; pwsh (.NET 5+) gets the modern Explorer dialog.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "if ($dialog.PSObject.Properties['AutoUpgradeEnabled']) { $dialog.AutoUpgradeEnabled = $true }",
  "$dialog.ShowNewFolderButton = $true",
  `if ($env:${INITIAL_ENV}) { $dialog.SelectedPath = $env:${INITIAL_ENV} }`,
  "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
  "try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } } finally { $owner.Dispose() }",
].join("\n");

const MAC_SCRIPT = [
  `set initialPath to system attribute "${INITIAL_ENV}"`,
  "try",
  '  if initialPath is not "" then',
  "    set chosen to choose folder default location (POSIX file initialPath)",
  "  else",
  "    set chosen to choose folder",
  "  end if",
  "  return POSIX path of chosen",
  "on error number -128",
  '  return ""',
  "end try",
].join("\n");

function usableInitial(initial: string | undefined): string | undefined {
  if (!initial?.trim() || /[\r\n\0]/.test(initial)) return undefined;
  return initial;
}

export function folderPickerLaunch(req: FolderPickerRequest): FolderPickerLaunch {
  const initial = usableInitial(req.initial);
  const env: Record<string, string> = initial ? { [INITIAL_ENV]: initial } : {};

  if (req.platform === "win32") {
    const powershell = req.which("pwsh") ?? req.which("powershell");
    if (powershell) {
      return {
        argv: [powershell, "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT],
        env,
      };
    }
  } else if (req.platform === "darwin") {
    const osascript = req.which("osascript");
    if (osascript) return { argv: [osascript, "-e", MAC_SCRIPT], env };
  } else {
    const start = initial ? `${initial.replace(/\/+$/, "")}/` : undefined;
    const zenity = req.which("zenity");
    if (zenity) {
      return {
        argv: [
          zenity,
          "--file-selection",
          "--directory",
          "--title=Choose a folder",
          ...(start ? ["--filename", start] : []),
        ],
        env: {},
      };
    }
    const kdialog = req.which("kdialog");
    if (kdialog) {
      return { argv: [kdialog, "--getexistingdirectory", ...(start ? [start] : [])], env: {} };
    }
  }
  throw new ValidationError("No folder picker is available on this machine");
}

// GTK dialogs print harmless warnings to stderr even when the user just cancels.
const NOISE = /^\s*(\(\S+:\d+\): )?(Gtk|Gdk|GLib|dbind|GLib-GIO)-(WARNING|CRITICAL|Message)/;

export function readPickedFolder(
  code: number | null,
  stdout: string,
  stderr: string,
): string | null {
  const picked = stdout.trim();
  if (code === 0 && picked) {
    return picked.length > 1 && picked.endsWith("/") ? picked.replace(/\/+$/, "") : picked;
  }
  const problem = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.test(line));
  if (problem.length > 0) throw new Error(`Folder picker failed: ${problem.join(" ")}`);
  return null;
}

export async function pickFolder(
  launch: FolderPickerLaunch,
  timeoutMs = 10 * 60_000,
): Promise<string | null> {
  const proc = Bun.spawn(launch.argv, {
    env: { ...process.env, ...launch.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return readPickedFolder(code, stdout, stderr);
  } finally {
    clearTimeout(timer);
  }
}
