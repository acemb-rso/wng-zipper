import { DOCK_OVERRIDE_STORAGE_KEY } from "./constants.js";
import { log } from "./utils.js";

let dockOverrideCache = null;

export function canPersistDockSettings() {
  try {
    const user = game?.user ?? null;
    if (!user) return false;
    if (user.isGM) return true;

    const perms = (foundry?.CONST?.USER_PERMISSIONS ?? globalThis?.CONST?.USER_PERMISSIONS) ?? null;
    const candidates = [
      perms?.CONFIGURE_SETTINGS,
      perms?.SETTINGS_MODIFY,
      "CONFIGURE_SETTINGS",
      "SETTINGS_MODIFY"
    ];

    for (const key of candidates) {
      if (!key) continue;
      if (typeof user.can === "function") {
        try {
          if (user.can(key)) return true;
        } catch (err) {
          // ignore permission resolution errors
        }
      }
      if (typeof user.hasPermission === "function") {
        try {
          if (user.hasPermission(key)) return true;
        } catch (err) {
          // ignore permission resolution errors
        }
      }
    }
  } catch (err) {
    log(err);
  }

  return false;
}

function accessLocalStorage() {
  try {
    return globalThis?.localStorage ?? null;
  } catch {
    return null;
  }
}

function readDockOverrideStorage() {
  const storage = accessLocalStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(DOCK_OVERRIDE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (err) {
    log(err);
  }
  return {};
}

function writeDockOverrideStorage(data) {
  const storage = accessLocalStorage();
  if (!storage) return;
  try {
    if (!data || !Object.keys(data).length) {
      storage.removeItem(DOCK_OVERRIDE_STORAGE_KEY);
    } else {
      storage.setItem(DOCK_OVERRIDE_STORAGE_KEY, JSON.stringify(data));
    }
  } catch (err) {
    log(err);
  }
}

export function getDockOverrides() {
  if (!dockOverrideCache) {
    dockOverrideCache = readDockOverrideStorage();
  }
  return { ...(dockOverrideCache ?? {}) };
}

export function updateDockOverrides(partial = {}) {
  if (!partial || typeof partial !== "object") return getDockOverrides();
  const current = getDockOverrides();
  let changed = false;
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    if (value === null) {
      if (key in current) {
        delete current[key];
        changed = true;
      }
      continue;
    }
    if (current[key] !== value) {
      current[key] = value;
      changed = true;
    }
  }
  if (changed) {
    dockOverrideCache = current;
    writeDockOverrideStorage(current);
  }
  return { ...current };
}

export function clearDockOverrides(keys = null) {
  if (keys === null) {
    dockOverrideCache = {};
    writeDockOverrideStorage({});
    return;
  }
  const list = Array.isArray(keys) ? keys : [keys];
  const current = getDockOverrides();
  let changed = false;
  for (const key of list) {
    if (key in current) {
      delete current[key];
      changed = true;
    }
  }
  if (changed) {
    dockOverrideCache = current;
    writeDockOverrideStorage(current);
  }
}
