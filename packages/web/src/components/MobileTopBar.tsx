import { Menu } from "lucide-react";

interface MobileTopBarProps {
  onOpenNav: () => void;
}

/**
 * Mobile-only top bar. Hidden at md+ via `md:hidden` on the caller/wrapper.
 * Renders a hamburger button (opens the nav drawer) and the ORC brand.
 */
export function MobileTopBar({ onOpenNav }: MobileTopBarProps) {
  return (
    <header className="shrink-0 h-12 px-3 flex items-center gap-3 border-b border-surface-highest bg-background md:hidden">
      <button
        type="button"
        data-testid="mobile-nav-open"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="p-2 -ml-2 text-on-surface-variant hover:text-primary transition-colors"
      >
        <Menu size={18} />
      </button>
      <div className="flex items-center gap-2">
        <span className="font-headline font-black tracking-wider text-primary terminal-glow text-lg">
          &#x25C8; ORC
        </span>
      </div>
    </header>
  );
}
