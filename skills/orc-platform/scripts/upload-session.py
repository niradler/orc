"""Snapshot supported native session files and upload an ORC handoff bundle."""

import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request


def snapshot(path: pathlib.Path) -> str:
    before = path.stat()
    content = path.read_text(encoding="utf-8-sig")
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Session changed during snapshot; wait for it to be idle and retry")
    return content


def build_bundle(agent: str, path: pathlib.Path) -> dict:
    files = [{"path": "session.jsonl", "content": snapshot(path)}]
    if agent == "claude":
        sidecars = path.parent / path.stem / "subagents"
        if sidecars.is_dir():
            for sidecar in sorted(sidecars.glob("agent-*.jsonl")):
                if sidecar.is_symlink():
                    raise ValueError("Session sidecars must not be symbolic links")
                files.append({"path": f"subagents/{sidecar.name}", "content": snapshot(sidecar)})
    if len(files) > 128:
        raise ValueError("Session has too many sidecars for one handoff")
    return {"version": 1, "files": files}


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Upload redirects are refused; request a link from the correct ORC API")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", required=True, choices=["claude", "codex"])
    parser.add_argument("--session-file", required=True, type=pathlib.Path)
    parser.add_argument("--upload-url", required=True)
    args = parser.parse_args()
    url = urllib.parse.urlparse(args.upload_url)
    if url.scheme not in ["http", "https"] or not url.netloc or url.username or url.password:
        raise ValueError("Expected an HTTP(S) upload URL from ORC")
    body = json.dumps(build_bundle(args.agent, args.session_file), ensure_ascii=False).encode("utf-8")
    if len(body) > 64 * 1024 * 1024:
        raise ValueError("Session bundle exceeds the 64 MiB upload limit")
    request = urllib.request.Request(args.upload_url, data=body, method="PUT", headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(NoRedirects())
    with opener.open(request, timeout=180) as response:
        result = json.load(response)
    print(json.dumps(result, indent=2))
    return 0 if result.get("status") == "ready" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as error:
        detail = "inspect the handoff through the authenticated API"
        try:
            payload = json.loads(error.read(4096))
            if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                detail = payload["error"][:1000]
        except (OSError, ValueError):
            pass
        print(f"ORC upload failed with HTTP {error.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError) as error:
        print(f"Session upload failed: {error}", file=sys.stderr)
        sys.exit(1)
