import { useCallback } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

/**
 * Treats `${basePath}/:paramName` as a shareable detail route for a list view.
 * Preserves the current query string so filters stay intact across open/close.
 */
export function useDetailRoute(basePath: string, paramName: string) {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const selectedId = (params[paramName] as string | undefined) ?? null;
  const open = selectedId !== null;

  const openDetail = useCallback(
    (id: string) => {
      navigate(`${basePath}/${encodeURIComponent(id)}${location.search}`);
    },
    [basePath, location.search, navigate],
  );

  const closeDetail = useCallback(() => {
    navigate(`${basePath}${location.search}`);
  }, [basePath, location.search, navigate]);

  return { selectedId, open, openDetail, closeDetail };
}
