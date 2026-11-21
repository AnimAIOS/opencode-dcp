import type { Theme } from "../tui/types";
/**
 * Picks the surface the dialogs render on: the host's dialog surface when the
 * host exposes `surface(name)` (2.0.10+), the legacy `contextual.overlay`
 * when present (2.0.4-era), else the base theme itself.
 */
export declare function resolveSurface(theme: unknown): unknown;
/**
 * Builds the ViewApi theme from a live host-theme accessor. `current` stays a
 * getter so a host that swaps or mutates the theme keeps flowing through.
 */
export declare function resolveViewTheme(getTheme: () => unknown): {
    readonly current: Theme;
};
//# sourceMappingURL=theme.d.ts.map