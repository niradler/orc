import { expect, test } from "bun:test";
import { gateEnv } from "./gate-env.js";

test("strips git hook exports and ORC runtime overrides, keeps asset and install overrides", () => {
  const env = gateEnv({
    PATH: "tools",
    HOME: "user",
    GIT_DIR: "/repo/.git",
    GIT_INDEX_FILE: "/repo/.git/index",
    ORC_HOME: "/real/.orc",
    ORC_API_SECRET: "live-secret",
    ORC_API_BASE: "http://127.0.0.1:17770",
    ORC_TELEGRAM_TOKEN: "live-token",
    ORC_DB_PATH: "/real/.orc/orc.db",
    orc_api_port: "7700",
    ORC_SQLITE_VEC_PATH: "/real/.orc/native/vec0.dll",
    ORC_DESKTOP_PATH: "/opt/orc/orc.exe",
  });
  expect(env).toEqual({
    PATH: "tools",
    HOME: "user",
    ORC_SQLITE_VEC_PATH: "/real/.orc/native/vec0.dll",
    ORC_DESKTOP_PATH: "/opt/orc/orc.exe",
  });
});

test("keeps an environment without overrides unchanged", () => {
  const env = { PATH: "tools", HOME: "user" };
  expect(gateEnv(env)).toEqual(env);
});
