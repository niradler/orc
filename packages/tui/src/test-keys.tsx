#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";

function TestApp() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [lastKey, setLastKey] = useState("(press any key)");
  const [count, setCount] = useState(0);

  useKeyboard((key) => {
    setLastKey(
      `name=${key.name} shift=${key.shift} ctrl=${key.ctrl} seq=${JSON.stringify(key.sequence)}`,
    );
    setCount((c) => c + 1);
    if (key.name === "q" && key.ctrl) renderer.destroy();
  });

  return (
    <box flexDirection="column" width={width} height={height}>
      <text fg="#00BFFF">{"Keyboard Test - press keys, Ctrl+Q to quit"}</text>
      <text fg="#FFFFFF">{`Last key: ${lastKey}`}</text>
      <text fg="#00FF7F">{`Key count: ${count}`}</text>
      <text fg="#666">{`Terminal: ${width}x${height}`}</text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<TestApp />);
