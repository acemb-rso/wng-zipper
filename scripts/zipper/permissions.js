import { OWNER_LEVEL, OBSERVER_LEVEL, SIDE_LABELS, STATUS_LABELS } from "./constants.js";

export const isPC = (c) => {
  try {
    if (!c) return false;
    if (typeof c.actor?.hasPlayerOwner === "boolean") return c.actor.hasPlayerOwner;
    const disp = c.token?.disposition ?? c.token?.document?.disposition;
    return disp === 1;
  } catch {
    return false;
  }
};

export const formatStatusLabel = (status, entry) => {
  if (entry?.isDefeated) return STATUS_LABELS.defeated;
  if (status && STATUS_LABELS[status]) return STATUS_LABELS[status];
  if (entry?.acted) return "Acted";
  return "Ready";
};

export const hasDocumentPermission = (doc, level) => {
  if (!doc || !game?.user) return false;

  try {
    if (typeof doc.testUserPermission === "function") {
      return !!doc.testUserPermission(game.user, level);
    }
  } catch {
    // Ignore permission resolution errors
  }

  const ownership = doc.ownership ?? doc.permission ?? null;
  if (!ownership) return false;

  if (Number.isFinite(ownership)) {
    return ownership >= level;
  }

  const userId = game.user.id;
  let value = ownership[userId];
  if (!Number.isFinite(value)) value = ownership.default;
  value = Number(value);
  return Number.isFinite(value) && value >= level;
};

export const computeEntryPermissions = (doc, actor, fallback = {}) => {
  if (game.user?.isGM) {
    return { isOwner: true, canControl: true };
  }

  const fallbackOwner = fallback.isOwner === true;
  let isOwner = fallbackOwner;
  let canControl = fallback.canControl ?? fallbackOwner;

  const docOwner = hasDocumentPermission(doc, OWNER_LEVEL);
  const docObserver = hasDocumentPermission(doc, OBSERVER_LEVEL);
  const actorOwner = hasDocumentPermission(actor, OWNER_LEVEL);
  const actorObserver = hasDocumentPermission(actor, OBSERVER_LEVEL);

  try {
    if (!isOwner && doc?.isOwner) isOwner = true;
  } catch {
    // Ignore
  }

  try {
    if (!isOwner && actor?.isOwner) isOwner = true;
  } catch {
    // Ignore
  }

  if (!isOwner && docOwner) {
    isOwner = true;
  }

  if (!isOwner && actorOwner) {
    isOwner = true;
  }

  if (!canControl) {
    if (isOwner) {
      canControl = true;
    } else if (docObserver) {
      canControl = true;
    } else {
      let actorHasPlayerOwner = false;
      try {
        actorHasPlayerOwner = !!actor?.hasPlayerOwner;
      } catch {
        actorHasPlayerOwner = false;
      }

      if (actorHasPlayerOwner && actorObserver) {
        canControl = true;
      }
    }
  }

  return { isOwner, canControl };
};

export const sanitizeEntry = (entry, selectedId) => {
  const statusLabel = formatStatusLabel(entry.status, entry);
  const doc = entry?.doc;
  const actor = doc?.actor;
  const { isOwner, canControl } = computeEntryPermissions(doc, actor, entry);
  return {
    id: entry.id,
    name: entry.name,
    img: entry.img,
    side: entry.side,
    acted: entry.acted,
    isCurrent: entry.isCurrent,
    isPending: entry.isPending,
    isComplete: entry.isComplete,
    isDefeated: entry.isDefeated,
    status: entry.status,
    statusLabel,
    hidden: entry.hidden,
    manualSelected: !!selectedId && entry.id === selectedId,
    isOwner,
    canControl
  };
};

export function isCombatantComplete(entry, combat = null) {
  if (!entry) return false;
  if (entry.isComplete === true) return true;

  const resolveDoc = () => {
    if (entry.doc) return entry.doc;
    if (combat?.combatants?.get) return combat.combatants.get(entry.id) ?? null;
    if (Array.isArray(combat?.combatants)) return combat.combatants.find((c) => c?.id === entry.id) ?? null;
    return entry.combatant ?? null;
  };

  try {
    const doc = resolveDoc();
    if (doc?.isComplete === true) return true;
    const docStatus = doc?.getFlag?.("wrath-and-glory", "combatStatus");
    if (docStatus === "complete") return true;
  } catch {
    // Ignore flag resolution issues
  }

  const status = entry.status ?? entry.combatStatus ?? entry.flags?.["wrath-and-glory"]?.combatStatus ?? null;
  return status === "complete";
}

export const toSideLabel = (side) => SIDE_LABELS[side] ?? null;

export const canActivateEntry = (entry, nextSide, allowPlayers) => {
  if (!entry) return false;
  if (nextSide && entry.side !== nextSide) return false;
  if (entry.side === "npc") return game.user.isGM;
  if (game.user.isGM) return true;
  if (typeof entry.canControl === "boolean") return entry.canControl;
  return !!allowPlayers;
};

export const canQueueEntry = (entry, nextSide, currentSide, allowPlayers, { combatStarted = true } = {}) => {
  if (!entry) return false;
  if (entry.isDefeated) return false;
  if (entry.acted || entry.isComplete) return false;
  if (entry.isCurrent) return false;

  const side = entry.side;

  if (side === "npc") {
    return game.user.isGM;
  }

  if (side === "pc") {
    if (game.user.isGM) return true;
    if (!allowPlayers) return false;
    if (!entry.canControl) return false;
    if (combatStarted && currentSide && currentSide !== "npc") return false;
    return true;
  }

  return false;
};
