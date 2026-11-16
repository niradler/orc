/**
 * Child-process environment for local gates and release steps.
 *
 * Git hooks export GIT_DIR, GIT_INDEX_FILE, ... pointing at the real repository,
 * and ORC-launched agent shells inject runtime overrides (ORC_HOME,
 * ORC_API_SECRET, ORC_TELEGRAM_TOKEN, ...). ORC_HOME defeats HOME/USERPROFILE
 * isolation because orcHome() prefers it, and live credentials must never reach
 * tests. Strip both families. Keep ORC_SQLITE_VEC_PATH (native sqlite-vec asset
 * lookup) and ORC_DESKTOP_PATH (the documented custom-install release override).
 */
export function gateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const name = key.toUpperCase();
      if (name.startsWith("GIT_")) return false;
      if (!name.startsWith("ORC_")) return true;
      return name === "ORC_SQLITE_VEC_PATH" || name === "ORC_DESKTOP_PATH";
    }),
  );
}
