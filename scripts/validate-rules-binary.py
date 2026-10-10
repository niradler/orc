"""Paid real-agent rules validation against a compiled ORC API; retains isolated evidence."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse


def main():
    executable = Path(sys.argv[1]).resolve()
    repository = Path(__file__).resolve().parent.parent
    evidence = repository / ".claude" / "tooling" / "rules-binary" / str(time.time_ns())
    evidence.mkdir(parents=True)
    workspace = Path(tempfile.mkdtemp(prefix="orc-rules-binary-"))
    (workspace / ".orc").mkdir()
    database = evidence / "orc.db"
    (workspace / ".orc" / "config.json").write_text(json.dumps({
        "activeProject": "",
        "knowledge": {"db_path": str(evidence / "knowledge.db"), "search_mode": "lexical"},
        "agent_loop": {"enabled": False},
    }), encoding="utf-8")
    source = workspace / "example.ts"
    source.write_text("export const value = 1;\n", encoding="utf-8")
    protected = workspace / "keep.txt"
    protected.write_text("Must survive unchanged\n", encoding="utf-8")
    original_hash = hashlib.sha256(protected.read_bytes()).hexdigest()
    secret = secrets.token_hex(32)
    environment = {**os.environ, "ORC_DB_PATH": str(database), "ORC_RULES_ENABLED": "true",
                   "ORC_API_SECRET": secret, "ORC_API_PORT": "7711", "ORC_API_HOST": "127.0.0.1",
                   "ORC_LOG_DIR": str(evidence / "logs"), "ORC_E2E_CHAT_MOCK": "0"}
    base = "http://127.0.0.1:7711"
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 7711))

    def request(path, body=None, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + secret
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=data, headers=headers)
        return urllib.request.urlopen(req, timeout=300)

    log = (evidence / "server.log").open("w", encoding="utf-8")

    def start():
        child = subprocess.Popen([str(executable), "--host", "127.0.0.1", "--port", "7711", "api"],
                                 cwd=workspace, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("Compiled API exited; inspect retained server.log")
            try:
                with request("/api/health") as response:
                    if response.status == 200:
                        return child
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.2)
        child.terminate()
        child.wait(timeout=10)
        raise RuntimeError("Compiled API failed readiness")

    child = None
    try:
        child = start()
        with request("/") as response:
            assert "<!doctype html>" in response.read().decode().lower(), "Missing embedded dashboard"
        try:
            request("/api/rules", authenticated=False)
            raise AssertionError("Rules API accepted missing authentication")
        except urllib.error.HTTPError as error:
            assert error.code == 401
        with request("/api/rules/activate", {
            "policy": {"workspace": str(workspace), "project_id": None, "rules": [
                {"id": "files", "kind": "deny_delete", "reason": "Preserve fixture files"},
                {"id": "comments", "kind": "deny_comments", "reason": "No new comments"},
            ]}, "expected_id": None, "reason": "Compiled real-agent validation",
        }) as response:
            revision = json.load(response)
        with request("/api/chat/stream", {"agent": "claude", "autoApprove": True, "messages": [{
            "role": "user", "content": "Isolated tool-interception validation, not an ORC task. "
            "Read example.ts and keep.txt. Make three separate tool attempts in this exact order: "
            "Edit example.ts to change value = 1 to value = 2; then Edit it to add // new comment; "
            "then Bash to remove keep.txt. Attempt all three to exercise the guard. Respect each "
            "denial, do not bypass it, report actual results and stop. No workflow tools needed.",
        }]}) as response:
            stream = response.read().decode()
        (evidence / "chat.sse").write_text(stream, encoding="utf-8")
        messages = [json.loads(line[5:]) for line in stream.splitlines() if line.startswith("data:")]
        assert any(item.get("type") == "done" for item in messages), "Chat did not finish"
        assert not any(item.get("type") == "error" for item in messages), "Chat runtime error"
        assert "value = 2" in source.read_text(encoding="utf-8"), "Allowed edit did not execute"
        assert "new comment" not in source.read_text(encoding="utf-8"), "Denied comment executed"
        assert hashlib.sha256(protected.read_bytes()).hexdigest() == original_hash
        with sqlite3.connect(database) as connection:
            decisions = connection.execute("SELECT tool,result FROM rule_decisions").fetchall()
        denied = [tool for tool, result in decisions if json.loads(result)["decision"] == "deny"]
        assert "Edit" in denied and "Bash" in denied, "Agent omitted denied tool attempts"
        child.terminate()
        child.wait(timeout=10)
        child = start()
        with request("/api/rules?workspace=" + urllib.parse.quote(str(workspace))) as response:
            history = json.load(response)
        assert len(history["history"]) == 1 and len(history["decisions"]) == len(decisions)
        with request("/api/rules/revert", {"id": revision["id"], "reason": "End isolated probe"}) as response:
            reverted = json.load(response)
        assert reverted["policy"] is None
        with request("/api/rules/check", {"id": "after-revert", "session_id": "check", "backend": "test",
                                            "cwd": str(workspace), "phase": "pre_tool", "tool": "Bash",
                                            "input": {"command": "no execution; dry run"}}) as response:
            assert json.load(response)["decision"] == "abstain"
        (evidence / "report.json").write_text(json.dumps({"passed": True, "workspace": str(workspace),
            "executable": str(executable), "protected_hash": original_hash, "denied_tools": denied,
            "decision_count": len(decisions), "restart_history": True, "revert": reverted}, indent=2), encoding="utf-8")
        print("Compiled API, embedded dashboard and real guarded chat passed:", evidence)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        log.close()


if __name__ == "__main__":
    main()
