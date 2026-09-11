/**
 * Client side of the settings API (GET/PUT /api/settings/:scope).
 *
 * Every *setting* in this portal must live on the server, not in localStorage: the same browser
 * profile is shared by the shell and every iframe, but a reinstall / another device / clearing
 * site data would silently lose localStorage values, and the value would be invisible from the
 * server side. See AGENTS.md ("设置与用户数据") and docs/TECHNICAL.md §4.
 *
 * No imports on purpose: this module is loaded by the shell AND by sub-apps, in the browser and
 * (for tests) in Node.
 */

export type SettingsResult<T> = { ok: true; value: T | null } | { ok: false; error: string };

function scopeUrl(scope: string): string {
  return "/api/settings/" + encodeURIComponent(scope);
}

/**
 * Load one scope. `value` is null when the scope was never saved (caller should fall back to its
 * own defaults); `ok: false` means the request itself failed and saving will likely fail too.
 */
export async function loadSettings<T = unknown>(scope: string): Promise<SettingsResult<T>> {
  try {
    const res = await fetch(scopeUrl(scope), { cache: "no-store" });
    if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    const data = (await res.json()) as { value?: T | null };
    return { ok: true, value: data.value ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Replace one scope's value. Never throws; the caller decides what to show on failure. */
export async function saveSettings(scope: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(scopeUrl(scope), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(value),
    });
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail += " — " + body.error;
      } catch {
        // non-JSON error body; the status alone is enough
      }
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
