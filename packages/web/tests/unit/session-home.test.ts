import { expect, test } from "bun:test";
import {
  clearSessionHome,
  patchSessionHome,
  readSessionHome,
  sessionHomeSearch,
} from "../../src/lib/session-home";

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
