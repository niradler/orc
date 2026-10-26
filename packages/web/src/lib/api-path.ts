/**
 * Whether a caller-chosen `path` stays under the ORC API once joined to `apiUrl` the way
 * apiFetch joins it. `//host`, `/../` or a full URL must not carry the dashboard's credentials
 * anywhere else.
 */
export function staysInApi(path: string, apiUrl: string, here: string): boolean {
  if (!/^\/(?![/\\])/.test(path)) return false;
  const base = new URL(apiUrl, here);
  const url = new URL(`${apiUrl}${path}`, here);
  const prefix = base.pathname.replace(/\/$/, "");
  return url.origin === base.origin && url.pathname.startsWith(`${prefix}/`);
}
