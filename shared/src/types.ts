/**
 * Shared contracts used by both the portal server and client code.
 * These are plain interfaces/constants so they can be imported anywhere.
 */

/** Metadata describing a single independent sub-application hosted by the portal. */
export interface SubAppManifest {
  /** Unique, URL-safe identifier. Must equal the folder name under /apps. */
  id: string;
  /** Human-readable display name shown on the portal card. */
  name: string;
  /** Short description shown on the portal card. */
  description?: string;
  /** Emoji or icon path used as the card icon. */
  icon?: string;
  /** Accent color (hex) used for the card / app chrome. */
  color?: string;
  /** Lower numbers appear first in the grid. */
  order?: number;
  /** Semantic version of this sub-app. */
  version?: string;
  /** Absolute path to the app entry page. Defaults to "/apps/<id>/". */
  entry?: string;
  /** Optional author credit. */
  author?: string;
  /** Optional numeric size hint (in KB) for nicer cards. */
  sizeKb?: number;
  /**
   * Preferred screen orientation. The shell (the TOP-LEVEL document) offers a button that
   * fullscreens itself and calls screen.orientation.lock() for apps declaring "landscape";
   * sub-apps cannot do it themselves because they run inside an iframe.
   */
  orientation?: "landscape" | "portrait";
}

/** The full portal manifest returned by GET /api/manifest. */
export interface PortalManifest {
  portal: {
    name: string;
    version: string;
    description?: string;
  };
  apps: SubAppManifest[];
}

/** Shared default accent color. */
export const DEFAULT_COLOR = "#4f6ff7";

export function normalizeManifest(raw: Partial<SubAppManifest>, folderId: string): SubAppManifest {
  return {
    id: raw.id ?? folderId,
    name: raw.name ?? folderId,
    description: raw.description ?? "",
    icon: raw.icon ?? "📦",
    color: raw.color ?? DEFAULT_COLOR,
    order: raw.order ?? 10_000,
    version: raw.version ?? "1.0.0",
    entry: raw.entry ?? `/apps/${folderId}/`,
    author: raw.author,
    sizeKb: raw.sizeKb,
    // Only the two real values survive; anything else (typos) degrades to "no preference".
    orientation: raw.orientation === "landscape" || raw.orientation === "portrait" ? raw.orientation : undefined,
  };
}
