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
  /**
   * ASSET INTAKE — declares that this sub-app accepts assets PUBLISHED by another sub-app at runtime
   * (today: the FBX→GLB converter's 「发布」 button). `accepts` lists file extensions (lowercase, no
   * dot). Declaring it is what gives the app the directory `data/assets/<id>/`, served read-only at
   * `/assets/<id>/<name>`; apps that do not declare it cannot receive uploads at all (the server
   * answers 415), and the publisher's target list is DISCOVERED from this field rather than
   * hardcoded — so a new game needs no server change and no change in the converter.
   */
  assets?: { accepts: string[] };
}

/** Extensions a manifest may declare in `assets.accepts`: short, lowercase, no dot. */
export const ASSET_EXT_RE = /^[a-z0-9]{1,8}$/;

/**
 * Normalise `assets.accepts` from hand-written JSON. Anything unusable is DROPPED, not thrown: a
 * typo (".GLB", "glb ", a number, an empty array, an object) must not turn into an app that silently
 * accepts writes of a type nobody expects. An empty result means "declares no intake" (undefined).
 */
export function normalizeAssetIntake(raw: unknown): { accepts: string[] } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const list = (raw as { accepts?: unknown }).accepts;
  if (!Array.isArray(list)) return undefined;
  const accepts: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const ext = item.trim().toLowerCase().replace(/^\.+/, "");
    if (!ASSET_EXT_RE.test(ext) || accepts.includes(ext)) continue;
    accepts.push(ext);
  }
  return accepts.length > 0 ? { accepts } : undefined;
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
    // Absent for every app that does not receive published assets (i.e. all but the games).
    assets: normalizeAssetIntake(raw.assets),
  };
}
