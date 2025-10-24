export const MODULE_ID = "wng-zipper-initiative";
export const MANUAL_CHOICE_FLAG = "manualChoice";
export const QUEUED_CHOICES_FLAG = "queuedChoices";
export const DOCK_TEMPLATE = "templates/zipper-tracker.hbs";
export const DOCK_WRAPPER_CLASS = "wng-zipper-tracker-container";
export const DOCK_ROOT_ID = "wng-zipper-dock";

export const DOCK_DEFAULTS = {
  anchor: "right",
  topOffset: 120,
  sideOffset: 16,
  width: 320,
  height: 0,
  maxHeightBuffer: 160,
  inactiveOpacity: 0.7,
  noCombatOpacity: 0.85,
  backgroundOpacity: 0.35
};

export const DOCK_SIZE_LIMITS = {
  width: { min: 200, max: 1200 },
  height: { min: 220, max: 2200 }
};

export const DOCK_OVERRIDE_STORAGE_KEY = `${MODULE_ID}.dockOverrides`;

export const SOCKET_EVENT = `module.${MODULE_ID}`;
export const SOCKET_TIMEOUT_MS = 8000;

export const STATUS_LABELS = {
  pending: "Pending",
  current: "Current",
  complete: "Complete",
  defeated: "Defeated"
};

export const SIDE_LABELS = {
  pc: "PCs",
  npc: "NPCs"
};

export const PLAYERS_SIDE = "pc";

export const OWNERSHIP_LEVELS = (() => {
  if (CONST?.DOCUMENT_OWNERSHIP_LEVELS) return CONST.DOCUMENT_OWNERSHIP_LEVELS;
  if (CONST?.DOCUMENT_PERMISSION_LEVELS) return CONST.DOCUMENT_PERMISSION_LEVELS;
  return { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
})();

export const OWNER_LEVEL = Number.isFinite(OWNERSHIP_LEVELS?.OWNER) ? OWNERSHIP_LEVELS.OWNER : 3;
export const OBSERVER_LEVEL = Number.isFinite(OWNERSHIP_LEVELS?.OBSERVER) ? OWNERSHIP_LEVELS.OBSERVER : 2;
