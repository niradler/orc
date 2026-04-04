import type { ApiResult } from "@orc/sdk/types";

export function expectApiData<T>(result: ApiResult<T>, fallback: string): T {
  if (result.error) {
    throw new Error(result.error.error || fallback);
  }

  if (result.data == null) {
    throw new Error(fallback);
  }

  return result.data;
}
