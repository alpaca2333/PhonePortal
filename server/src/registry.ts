/**
 * Sub-application registry.
 * Scans the /apps directory for <app>/manifest.json files so that new
 * sub-apps are discovered automatically — no server code change needed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PortalManifest, SubAppManifest } from "../../shared/src/types.js";
import { normalizeManifest } from "../../shared/src/types.js";

/** Project root, derived from this file's location (dist/server/src/...). */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Source folder holding each sub-app's manifest.json. */
export const APPS_ROOT = path.join(ROOT, "apps");
/** Built web root served to clients. */
export const DIST_ROOT = path.join(ROOT, "dist");

const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));

export const PORTAL = {
  name: "手机门户",
  version: packageJson.version ?? "0.0.0",
  description: "本机运行的门户，聚合多个独立子应用",
};

/** Load and normalise every sub-app manifest. */
export async function loadRegistry(): Promise<PortalManifest> {
  const apps: SubAppManifest[] = [];
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(APPS_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { portal: PORTAL, apps };
  }

  for (const id of entries) {
    const manifestPath = path.join(APPS_ROOT, id, "manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SubAppManifest>;
      apps.push(normalizeManifest(parsed, id));
    } catch {
      // A folder without a valid manifest.json is not a sub-app; skip it.
    }
  }

  apps.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name));
  return { portal: PORTAL, apps };
}

/** Resolve one app by id. */
export async function getApp(id: string): Promise<SubAppManifest | null> {
  const registry = await loadRegistry();
  return registry.apps.find((a) => a.id === id) ?? null;
}
