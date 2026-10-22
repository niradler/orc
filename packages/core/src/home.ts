import { homedir } from "node:os";

export function userHome(): string {
  return (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();
}
