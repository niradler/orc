import { Portal } from "@radix-ui/react-tooltip";
import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Hover/focus explains an icon; a touch hold explains it without executing its action. */
export function ActionHelp({
  label,
  description,
  children,
  touchHelp = true,
}: {
  label: string;
  description?: string;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  touchHelp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const props = children.props;
  const trigger = cloneElement(children, {
    onPointerDownCapture(event) {
      props.onPointerDownCapture?.(event);
      clear();
      held.current = false;
      if (!touchHelp || event.pointerType !== "touch" || event.defaultPrevented) return;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        held.current = true;
        setOpen(true);
      }, 500);
    },
    onPointerMoveCapture(event) {
      props.onPointerMoveCapture?.(event);
      if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10)
        clear();
    },
    onPointerUpCapture(event) {
      props.onPointerUpCapture?.(event);
      clear();
      if (held.current) event.preventDefault();
    },
    onPointerCancelCapture(event) {
      props.onPointerCancelCapture?.(event);
      clear();
      held.current = false;
    },
    onClickCapture(event) {
      if (held.current) {
        event.preventDefault();
        event.stopPropagation();
        held.current = false;
        return;
      }
      props.onClickCapture?.(event);
    },
    onContextMenu(event) {
      if (held.current) event.preventDefault();
      props.onContextMenu?.(event);
    },
  });
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <Portal>
          <TooltipContent
            data-testid="action-help-content"
            collisionPadding={12}
            className="max-w-72 text-sm leading-relaxed"
          >
            {description ?? label}
          </TooltipContent>
        </Portal>
      </Tooltip>
    </TooltipProvider>
  );
}
