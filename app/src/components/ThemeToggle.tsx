"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

/** Reads the theme the no-flash boot script (in layout.tsx) already applied to
 *  <html data-theme>, so the button starts in sync with what's on screen. */
function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Sun/moon toggle in the top bar. Flips <html data-theme> and persists the
 *  choice to localStorage so it survives reloads and pre-paints next time. */
export function ThemeToggle() {
  // Start as null so the server render and first client render match (the real
  // value is only known on the client); fill it in after mount.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => setTheme(currentTheme()), []);

  const toggle = () => {
    const next: Theme = (theme ?? currentTheme()) === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* private mode / storage disabled — the in-memory flip still works */
    }
    setTheme(next);
  };

  const isLight = theme === "light";
  const label = isLight ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button
      type="button"
      className="topbar-bell"
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      {/* Render the icon for the mode you'll switch *to*. Until mounted, theme is
          null and we show the moon — harmless and avoids a hydration mismatch. */}
      {isLight ? (
        // Moon
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      ) : (
        // Sun
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  );
}
