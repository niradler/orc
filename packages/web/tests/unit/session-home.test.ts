import { expect, test } from "bun:test";
import {
  clearSessionHome,
  patchSessionHome,
  readSessionHome,
  sameSessionFolder,
  sessionHomeSearch,
  swapSessionPanes,
} from "../../src/lib/session-home";

test("should promote a parallel session with its own terminal, file and inspector navigation", () => {
  const original = new URLSearchParams(
    "project=p&chat=full&chatThread=first&sessionTerminal=t1&inspectorfile=a.txt&parallelchatThread=second&parallelsessionTerminal=t2&parallelinspectorfile=b.txt&q=keep",
  );
  const swapped = swapSessionPanes(original);
  expect(swapped.get("chatThread")).toBe("second");
  expect(swapped.get("sessionTerminal")).toBe("t2");
  expect(swapped.get("inspectorfile")).toBe("b.txt");
  expect(swapped.get("parallelchatThread")).toBe("first");
  expect(swapped.get("parallelsessionTerminal")).toBe("t1");
  expect(swapped.get("project")).toBe("p");
  expect(swapped.get("q")).toBe("keep");
  expect(swapSessionPanes(swapped).toString()).toBe(original.toString());
});

test("should reuse Windows folder spellings without treating distinct POSIX paths as one checkout", () => {
  expect(sameSessionFolder("C:/Projects/ORC", "\\\\?\\C:\\Projects\\orc\\")).toBe(true);
  expect(sameSessionFolder("/work/ORC", "/work/orc")).toBe(false);
  expect(sameSessionFolder("/work/orc", "/work/orc/")).toBe(true);
  expect(sameSessionFolder(null, null)).toBe(false);
});

test("reads the full-width session view state from the URL and ignores unknown values", () => {
  expect(readSessionHome(new URLSearchParams("chat=full"))).toEqual({
    terminalId: null,
    liveId: null,
    listHidden: false,
    listOpen: false,
    inspector: null,
    drawer: false,
  });
  expect(
    readSessionHome(
      new URLSearchParams(
        "sessionTerminal=t1&sessionLive=l1&sessionList=hide&inspector=diff&drawer=terminal",
      ),
    ),
  ).toEqual({
    terminalId: "t1",
    liveId: "l1",
    listHidden: true,
    listOpen: false,
    inspector: "diff",
    drawer: true,
  });
  expect(readSessionHome(new URLSearchParams("inspector=terminal&drawer=1")).inspector).toBeNull();
  expect(readSessionHome(new URLSearchParams("drawer=1")).drawer).toBe(false);
});

test("a patch changes only the keys it names and keeps unrelated params", () => {
  const base = new URLSearchParams("project=p&chat=full&chatThread=c1&inspector=overview");
  const next = patchSessionHome(base, { terminalId: "t1", listHidden: true });
  expect(next.toString()).toBe(
    "project=p&chat=full&chatThread=c1&inspector=overview&sessionTerminal=t1&sessionList=hide",
  );
  expect(patchSessionHome(next, { inspector: null, listHidden: false }).toString()).toBe(
    "project=p&chat=full&chatThread=c1&sessionTerminal=t1",
  );
  expect(base.toString()).toBe("project=p&chat=full&chatThread=c1&inspector=overview");
});

test("clearing removes every session view param and nothing else", () => {
  const params = new URLSearchParams(
    "project=p&chat=full&sessionTerminal=t&sessionLive=l&sessionList=hide&inspector=diff&drawer=terminal&q=x",
  );
  expect(clearSessionHome(params).toString()).toBe("project=p&chat=full&q=x");
});

test("links from other pages keep only the project scope and prefer the terminal target", () => {
  expect(sessionHomeSearch("?project=p&session=old&q=x")).toBe("?project=p&chat=full");
  expect(sessionHomeSearch("", { liveId: "l1" })).toBe("?chat=full&sessionLive=l1");
  expect(sessionHomeSearch("?project=p", { terminalId: "t1", liveId: "l1" })).toBe(
    "?project=p&chat=full&sessionTerminal=t1",
  );
});

test("phone list visibility survives URL round trips without overwriting a collapsed desktop list", () => {
  const base = new URLSearchParams("project=p&chat=full&sessionList=hide");
  expect(patchSessionHome(base, { listOpen: false }).get("sessionList")).toBe("hide");
  const opened = patchSessionHome(base, { listOpen: true });
  expect(readSessionHome(opened).listOpen).toBe(true);
  expect(readSessionHome(opened).listHidden).toBe(false);
  expect(patchSessionHome(opened, { listOpen: false }).has("sessionList")).toBe(false);
  expect(clearSessionHome(opened).get("project")).toBe("p");
});
