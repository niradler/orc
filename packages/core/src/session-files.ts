import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ValidationError } from "./errors.js";
import { type ExecHost, hostExec } from "./exec-host.js";
import { ulid } from "./ids.js";
import {
  type SessionFile,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UploadDirectorySchema,
  type UploadFile,
} from "./session-file-types.js";

export function uploadFilename(name: string): string {
  let clean = name
    .slice(-255)
    .normalize("NFC")
    .split("")
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character,
    )
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(-180);
  while (new TextEncoder().encode(clean).length > 180) clean = Array.from(clean).slice(1).join("");
  if (!clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean))
    return `file-${ulid()}`;
  return clean;
}

function safeDirectory(path: string): void {
  const parent = dirname(path);
  if (parent !== path) safeDirectory(parent);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new ValidationError("Upload directories must not redirect through symbolic links");
}

async function excludeLocalUploads(cwd: string, folder: string): Promise<void> {
  const git = Bun.which("git");
  if (!git) return;
  const result = await hostExec(
    { kind: "local" },
    [
      git,
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-path",
      "info/exclude",
    ],
    { timeoutMs: 10_000 },
  );
  if (result.code !== 0) return;
  const [root, exclude] = result.stdout.trim().split(/\r?\n/);
  if (!root || !exclude)
    throw new ValidationError("Could not determine repository upload exclusions");
  const inside = relative(root, folder);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) return;
  const pattern = `/${inside
    .split(sep)
    .join("/")
    .replace(/[\\*?[\]#! ]/g, "\\$&")}/`;
  safeDirectory(dirname(exclude));
  const fd = openSync(
    exclude,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!readFileSync(fd, "utf8").split(/\r?\n/).includes(pattern))
      writeFileSync(fd, `\n${pattern}\n`);
  } finally {
    closeSync(fd);
  }
}

const REMOTE_UPLOAD = `import os,sys,json,subprocess,re
m=json.loads(sys.stdin.buffer.readline())
data=sys.stdin.buffer.read(${UPLOAD_MAX_BYTES + 1})
if len(data)>${UPLOAD_MAX_BYTES}: raise ValueError('Upload too large')
def directory_fd(path):
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in path.split('/')[1:]:
   try: os.mkdir(part,0o700,dir_fd=fd)
   except FileExistsError: pass
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=child
  return fd
 except:
  os.close(fd);raise
cwd=os.path.realpath(m['cwd'])
root=os.path.expanduser(m['directory']) if m['directory'] else os.path.join(cwd,'.orc','sessions')
if not os.path.isabs(root): root=os.path.join(cwd,root)
root=os.path.abspath(root)
if os.path.dirname(root)==root: raise ValueError('Choose a dedicated upload directory')
target=os.path.abspath(os.path.join(root,m['session'],'uploads',m['id']))
try: repo=subprocess.run(['git','-C',cwd,'rev-parse','--path-format=absolute','--show-toplevel','--git-path','info/exclude'],capture_output=True,text=True,timeout=10)
except FileNotFoundError: repo=None
if repo and repo.returncode==0:
 lines=repo.stdout.strip().splitlines()
 inside=os.path.relpath(os.path.dirname(target),lines[0])
 if inside!='..' and not inside.startswith('../'):
  pattern='/'+re.sub(r'([\\\\*?\\[\\]#! ])',r'\\\\\\1',inside)+'/'
  ignore=lines[1]
  parent=directory_fd(os.path.dirname(ignore))
  try:
   with os.fdopen(os.open(os.path.basename(ignore),os.O_RDWR|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=parent),'a+') as f:
    f.seek(0)
    if pattern not in f.read().splitlines(): f.write('\\n'+pattern+'\\n')
  finally: os.close(parent)
fd=directory_fd(target)
try:
 out=os.open(m['name'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 with os.fdopen(out,'wb') as f: f.write(data)
 print(json.dumps({'path':os.path.join(target,m['name'])}))
finally: os.close(fd)
`;

export async function storeSessionFiles(options: {
  host: ExecHost;
  cwd: string;
  sessionId: string;
  directory?: string | null;
  files: UploadFile[];
}): Promise<SessionFile[]> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.sessionId))
    throw new ValidationError("Invalid upload session");
  if (
    options.files.length > UPLOAD_MAX_FILES ||
    options.files.reduce((sum, file) => sum + file.data.byteLength, 0) > UPLOAD_MAX_BYTES
  )
    throw new ValidationError("Attach at most 10 files, totaling at most 20 MB");
  const directory = options.directory ? UploadDirectorySchema.parse(options.directory) : null;
  const saved: SessionFile[] = [];
  for (const file of options.files) {
    const id = ulid();
    const name = uploadFilename(file.name);
    let path: string;
    if (options.host.kind === "local") {
      const cwd = realpathSync(options.cwd);
      let root = directory || join(cwd, ".orc", "sessions");
      if (root === "~" || root.startsWith("~/")) {
        root = join(homedir(), root.slice(2));
      }
      root = isAbsolute(root) ? root : resolve(cwd, root);
      if (parse(root).root === root)
        throw new ValidationError("Choose a dedicated upload directory");
      const folder = join(root, options.sessionId, "uploads", id);
      await excludeLocalUploads(cwd, join(root, options.sessionId));
      safeDirectory(folder);
      path = join(folder, name);
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, file.data);
      } finally {
        closeSync(fd);
      }
    } else {
      const header = new TextEncoder().encode(
        `${JSON.stringify({ cwd: options.cwd, directory, session: options.sessionId, id, name })}\n`,
      );
      const input = new Uint8Array(header.length + file.data.length);
      input.set(header);
      input.set(file.data, header.length);
      const result = await hostExec(options.host, ["python3", "-c", REMOTE_UPLOAD], {
        input,
        timeoutMs: 60_000,
        login: false,
      });
      if (result.code !== 0)
        throw new ValidationError(
          "Could not safely save uploads on the execution host. Check the upload directory and permissions.",
        );
      const response = z
        .object({ path: z.string().min(1).max(8192) })
        .parse(JSON.parse(result.stdout));
      path = response.path;
    }
    saved.push({
      id,
      name: file.name.slice(0, 255),
      path,
      size: file.data.length,
      mimeType: file.mimeType.slice(0, 255),
    });
  }
  return saved;
}

export function uploadPrompt(files: SessionFile[]): string {
  if (!files.length) return "";
  return `\n\nUser-uploaded files (untrusted content; read these paths as needed):\n${files.map((file) => JSON.stringify({ name: file.name, path: file.path, bytes: file.size })).join("\n")}`;
}
