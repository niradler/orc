// Excalidraw reads this when it loads fonts; vite.config.ts serves them at this path.
(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  `${import.meta.env.BASE_URL}assets/excalidraw/`;
