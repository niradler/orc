"""Sync local Claude/Codex histories to ORC without launching agents.

Use --help for project/cwd/agent selection. Authentication comes from ORC_API_SECRET,
never argv. --dry-run previews mapping. Source files and agent credentials are untouched.
Repeated snapshots are idempotent; divergent revisions are retained as conflicts.
"""

import argparse
import concurrent.futures
import datetime
import functools
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("ORC redirects refused; use the final API URL")


def request(base, path, body=None):
    if "/api/session-sync/" in base:
        path = path.removeprefix("/sessions/archive")
    headers = {"Content-Type": "application/json", "x-orc-source": "cli"}
    token = None if "/api/session-sync/" in base else os.environ.get("ORC_API_SECRET")
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    if data is not None and len(data) > 64 * 1024 * 1024:
        raise ValueError("Encoded session exceeds the 64 MiB limit")
    req = urllib.request.Request(base + path, data=data, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.build_opener(NoRedirects()).open(req, timeout=180) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 409:
                return json.load(error)
            if error.code not in (429, 502, 503, 504) or attempt == 2:
                raise ValueError(f"ORC HTTP {error.code}; check API access and project mapping") from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise ValueError("ORC connection failed after three attempts") from None
        time.sleep(2 ** attempt)


def snapshot(path):
    before = path.stat()
    if before.st_size > 60 * 1024 * 1024:
        raise ValueError("Native file exceeds 60 MiB; select a smaller session")
    text = path.read_text(encoding="utf-8-sig")
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Session changed while reading; retry once it is idle")
    lines = text.splitlines()
    if lines and not text.endswith("\n"):
        try:
            json.loads(lines[-1])
        except ValueError:
            lines.pop()
    rows = [json.loads(line) for line in lines if line.strip()]
    if not rows or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Expected nonempty native JSONL objects")
    return "\n".join(lines) + "\n", rows


def repository_key(value):
    value = value.strip().rstrip("/").removesuffix(".git")
    if value.startswith("git@") and ":" in value:
        value = value[4:].replace(":", "/", 1)
    parsed = urllib.parse.urlparse(value)
    port = (":" + str(parsed.port)) if parsed.port else ""
    return ((parsed.hostname or "") + port + parsed.path if parsed.scheme else value).casefold()


def normalized_path(value):
    text = value.replace("\\", "/")
    if text.startswith("//?/"):
        text = text[4:]
    if len(text) > 1 and text[1] == ":":
        text = text.casefold()
    return text.rstrip("/")


@functools.lru_cache(maxsize=4096)
def local_repository(cwd):
    if not cwd or not pathlib.Path(cwd).is_dir():
        return None, ""
    try:
        remote = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        prefix = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-prefix"], capture_output=True, text=True, timeout=5, check=True).stdout.strip().rstrip("/")
        return remote, prefix
    except (OSError, subprocess.SubprocessError):
        return None, ""


def identify(agent, path, text, rows):
    if agent == "codex":
        meta = rows[0].get("payload", {})
        if rows[0].get("type") != "session_meta" or not isinstance(meta, dict):
            raise ValueError("Codex file lacks session_meta")
        native_id = meta.get("id")
        metadata = {"cwd": meta.get("cwd", ""), "subdirectory": ""}
        if meta.get("cli_version"):
            metadata["agent_version"] = str(meta["cli_version"])
        if meta.get("parent_thread_id"):
            metadata["parent_id"] = str(meta["parent_thread_id"])
        git = meta.get("git", {})
        if isinstance(git, dict):
            for key, source in [("repository", "repository_url"), ("branch", "branch"), ("commit", "commit_hash")]:
                if git.get(source):
                    metadata[key] = git[source]
    else:
        native = next((r for r in rows if r.get("sessionId") and r.get("type") in ("user", "assistant")), None)
        if not native:
            raise ValueError("Claude file lacks native conversation metadata")
        native_id = native["sessionId"]
        metadata = {"cwd": native.get("cwd", ""), "subdirectory": ""}
        if native.get("version"):
            metadata["agent_version"] = str(native["version"])
        if native.get("gitBranch"):
            metadata["branch"] = str(native["gitBranch"])
    uuid.UUID(native_id)
    cwd = metadata.get("cwd")
    remote, prefix = local_repository(cwd)
    if remote and "repository" not in metadata:
        metadata["repository"] = remote
    metadata["subdirectory"] = prefix
    if metadata.get("repository"):
        parsed = urllib.parse.urlparse(metadata["repository"])
        if parsed.scheme in ("http", "https"):
            metadata["repository"] = urllib.parse.urlunparse(parsed._replace(netloc=parsed.hostname + (":" + str(parsed.port) if parsed.port else ""), query="", fragment=""))
    files = [{"path": "session.jsonl", "content": text}]
    sidecars = path.parent / path.stem / "subagents"
    if agent == "claude" and sidecars.is_dir():
        for sidecar in sorted(sidecars.glob("agent-*.jsonl")):
            if sidecar.is_symlink():
                raise ValueError("Symbolic-link sidecars are not supported")
            files.append({"path": "subagents/" + sidecar.name, "content": snapshot(sidecar)[0]})
    if len(files) > 128:
        raise ValueError("Too many sidecars")
    title = path.stem
    for row in rows:
        message = row.get("message") or row.get("payload") or {}
        if not isinstance(message, dict):
            continue
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            content = " ".join(str(b.get("text", "")) for b in content if isinstance(b, dict))
        if (row.get("type") == "user" or message.get("role") == "user") and isinstance(content, str) and content.strip():
            title = " ".join(content.split())[:200]
            break
    timestamps = []
    for row in rows:
        stamp = row.get("timestamp")
        if isinstance(stamp, str):
            try:
                date = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                if date.tzinfo:
                    timestamps.append(date.astimezone(datetime.timezone.utc).isoformat())
            except ValueError:
                pass
    if timestamps:
        metadata.update(started_at=min(timestamps), ended_at=max(timestamps))
    return {"agent": agent, "session_id": native_id, "title": title[:200], "metadata": metadata, "bundle": {"version": 1, "files": files}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("ORC_API_BASE"), help="ORC server base URL; HTTPS required except loopback")
    parser.add_argument("--grant-file", type=pathlib.Path, help="Private JSON returned by the connected agent's session_sync tool; no main API secret needed")
    parser.add_argument("--grant-stdin", action="store_true", help="Read session_sync grant JSON from stdin instead of a file")
    parser.add_argument("--project", help="Existing ORC project for the selected sessions")
    parser.add_argument("--project-map", type=pathlib.Path, help="JSON mapping of source cwd prefixes or repository URLs to ORC project names")
    parser.add_argument("--agent", choices=["all", "claude", "codex"], default="all")
    parser.add_argument("--cwd", help="Only sessions at or below this local project directory")
    parser.add_argument("--exclude", action="append", default=[], help="Skip native paths matching this glob; repeatable")
    parser.add_argument("--root", type=pathlib.Path, help="Override native projects/sessions root; requires --agent")
    parser.add_argument("--session-file", action="append", type=pathlib.Path, help="Explicit native file; repeatable; requires --agent")
    parser.add_argument("--source-id", help="Stable origin ID; defaults to a UUID persisted in ~/.orc/session-sync-id")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--reindex", action="store_true", help="Resend unchanged snapshots to refresh/recover their search index")
    parser.add_argument("--dry-run", action="store_true", help="Preview discovery and project mapping without uploads")
    args = parser.parse_args()
    if args.grant_file and args.grant_stdin:
        parser.error("Choose --grant-file or --grant-stdin")
    if args.grant_file or args.grant_stdin:
        grant = json.loads(args.grant_file.read_text()) if args.grant_file else json.load(sys.stdin)
        args.url = grant.get("sync_url")
    if not args.url:
        parser.error("Set --url or ORC_API_BASE")
    url = urllib.parse.urlparse(args.url)
    if (args.grant_file or args.grant_stdin) and not re.search(r"/api/session-sync/[A-Za-z0-9_-]{43}$", url.path):
        parser.error("Expected a scoped session_sync capability")
    if url.username or url.password or url.query or url.fragment or url.scheme not in ("http", "https") or (url.scheme != "https" and url.hostname not in ("localhost", "127.0.0.1", "::1")):
        parser.error("Use credential-free HTTPS (or loopback HTTP)")
    if (args.root or args.session_file) and args.agent == "all":
        parser.error("Select --agent with --root or --session-file")
    base = args.url.rstrip("/") if re.search(r"/api/session-sync/[A-Za-z0-9_-]{43}$", url.path) else args.url.rstrip("/").removesuffix("/api") + "/api"
    projects = request(base, "/projects?limit=100")["projects"]
    names = {p["name"].casefold(): p["name"] for p in projects}
    mappings = json.loads(args.project_map.read_text()) if args.project_map else {}
    if not isinstance(mappings, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k,v in mappings.items()):
        parser.error("--project-map must map cwd/repository strings to project name strings")
    if args.project and args.project.casefold() not in names:
        parser.error("--project must name an existing ORC project")
    identity = pathlib.Path.home() / ".orc" / "session-sync-id"
    if args.source_id:
        source_id = args.source_id
    else:
        identity.parent.mkdir(parents=True, exist_ok=True)
        try:
            with identity.open("x") as handle:
                handle.write(str(uuid.uuid4()))
        except FileExistsError:
            pass
        source_id = identity.read_text().strip()
    receipt_base = base.split("/api/session-sync/")[0] + "/api" if "/api/session-sync/" in base else base
    receipts = pathlib.Path.home() / ".orc" / "session-sync-receipts" / hashlib.sha256(receipt_base.encode()).hexdigest()
    if not args.dry_run:
        receipts.mkdir(parents=True, exist_ok=True)
    candidates = []
    for agent in (["claude", "codex"] if args.agent == "all" else [args.agent]):
        root = args.root or ((pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR", str(pathlib.Path.home() / ".claude"))) / "projects") if agent == "claude" else pathlib.Path(os.environ.get("CODEX_HOME", str(pathlib.Path.home() / ".codex"))) / "sessions")
        paths = args.session_file or sorted(root.rglob("*.jsonl"))
        if not args.session_file and not args.root and agent == "codex":
            paths += sorted((root.parent / "archived_sessions").rglob("*.jsonl"))
        candidates.extend((agent, p) for p in paths if not p.is_symlink() and "subagents" not in p.parts and not any(p.match(pattern) for pattern in args.exclude))
    def sync(item):
        agent, path = item
        try:
            text, rows = snapshot(path)
            upload = identify(agent, path, text, rows)
            cwd = upload["metadata"].get("cwd", "")
            if args.cwd and not (normalized_path(cwd) == normalized_path(os.path.abspath(args.cwd)) or normalized_path(cwd).startswith(normalized_path(os.path.abspath(args.cwd)) + "/")):
                return "excluded"
            project = args.project
            if not project:
                repo = repository_key(upload["metadata"].get("repository", ""))
                matches = {value for key, value in mappings.items() if (cwd and (normalized_path(cwd) == normalized_path(key) or normalized_path(cwd).startswith(normalized_path(key) + "/"))) or (repo and repository_key(key) == repo)}
                matches.update(p["name"] for p in projects if repo and p.get("git_remote_url") and repository_key(p["git_remote_url"]) == repo)
                if len(matches) == 1:
                    project = matches.pop()
            if not project or project.casefold() not in names:
                print(f"UNMAPPED {agent} {upload['session_id']}; select --project or --project-map", file=sys.stderr)
                return "unmapped"
            upload.update(project=names[project.casefold()], source_id=source_id)
            if args.reindex:
                upload["reindex"] = True
            if args.dry_run:
                print(f"WOULD UPLOAD {agent} {upload['session_id']} -> {upload['project']}")
                return "preview"
            receipt_path = receipts / (hashlib.sha256(f"{source_id}:{agent}:{upload['session_id']}".encode()).hexdigest() + ".json")
            local_hash = hashlib.sha256(json.dumps(upload["bundle"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            identity_request = {key: upload[key] for key in ("project", "source_id", "agent", "session_id")}
            head = request(base, "/sessions/archive/manifest", {"sessions": [identity_request]})["sessions"][0]["archive"]
            try:
                receipt = json.loads(receipt_path.read_text())
            except (OSError, ValueError):
                receipt = {}
            if not args.reindex and receipt.get("local_hash") == local_hash and head and receipt.get("remote_hash") == head["content_hash"]:
                print(f"UNCHANGED {agent} {upload['session_id']} (manifest verified)")
                return "unchanged"
            result = request(base, "/sessions/archive/upload", upload)
            outcome = result["outcome"]
            if outcome in ("created", "updated", "unchanged"):
                temporary = receipt_path.with_suffix("." + uuid.uuid4().hex + ".tmp")
                temporary.write_text(json.dumps({"local_hash": local_hash, "remote_hash": result["session"]["content_hash"]}))
                os.replace(temporary, receipt_path)
            print(f"{outcome.upper()} {agent} {upload['session_id']} revision={result['session']['revision']}")
            return outcome
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(f"FAILED {agent} {path.name}: {error}", file=sys.stderr)
            return "failed"
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        outcomes = list(pool.map(sync, candidates))
    counts = {key: outcomes.count(key) for key in sorted(set(outcomes))}
    print(json.dumps({"discovered": len(candidates), "results": counts}))
    return 1 if any(k in counts for k in ("failed", "conflict", "unmapped")) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"Session sync failed: {error}", file=sys.stderr)
        sys.exit(1)
