import {
  MANUAL_CHOICE_FLAG,
  MODULE_ID,
  OWNER_LEVEL,
  QUEUED_CHOICES_FLAG,
  SOCKET_EVENT,
  SOCKET_TIMEOUT_MS
} from "./constants.js";
import { createEnrichedError, log } from "./utils.js";
import { hasDocumentPermission, isCombatantComplete, isPC } from "./permissions.js";

const pendingSocketRequests = new Map();
let socketBridgeInitialized = false;
let socketBridgeRetryTimer = null;

export const queuePromptBypass = new Set();

export const emptyQueue = () => ({ pc: null, npc: null });

export const cloneQueueState = (queue) => ({
  pc: typeof queue?.pc === "string" && queue.pc.length ? queue.pc : null,
  npc: typeof queue?.npc === "string" && queue.npc.length ? queue.npc : null
});

export const isQueueEmpty = (queue) => !(queue?.pc || queue?.npc);

function handleSocketFailure(baseMessage, err) {
  const { message, enriched } = createEnrichedError(baseMessage, err);
  log(err);
  if (ui?.notifications?.error) {
    ui.notifications.error(message);
  }
  return enriched;
}

export function resolveCombatById(combatId) {
  if (!combatId) return null;
  if (game.combat?.id === combatId) return game.combat;
  if (typeof game.combats?.get === "function") return game.combats.get(combatId) ?? null;
  if (Array.isArray(game.combats)) return game.combats.find((c) => c?.id === combatId) ?? null;
  return null;
}

function generateSocketRequestId() {
  if (globalThis?.foundry?.utils?.randomID) return foundry.utils.randomID();
  if (typeof randomID === "function") return randomID();
  return Math.random().toString(36).slice(2);
}

function handleSocketResponse(payload = {}) {
  const requestId = payload.requestId;
  if (!requestId) return;
  const pending = pendingSocketRequests.get(requestId);
  if (!pending) return;
  if (pending.timeoutId) (globalThis.clearTimeout ?? clearTimeout)(pending.timeoutId);
  pendingSocketRequests.delete(requestId);
  if (payload.success) {
    pending.resolve(payload.result ?? null);
  } else {
    const message = payload.error ?? "GM request failed.";
    pending.reject(new Error(message));
  }
}

async function applyImmediateActivation(combat, combatantId, sideHint = null) {
  if (!combat) throw new Error("Combat not found.");
  if (!combatantId) throw new Error("Missing combatant identifier.");

  const doc = combat.combatants?.get?.(combatantId) ?? null;
  if (!doc) throw new Error("Combatant not found.");

  const enabled = await combat.getFlag(MODULE_ID, "enabled");
  let side = sideHint;
  if (!["pc", "npc"].includes(side)) {
    side = isPC(doc) ? "pc" : "npc";
  }

  if (enabled) {
    if (side) {
      try {
        await combat.setFlag(MODULE_ID, "currentSide", side);
      } catch (err) {
        log(err);
      }
    }

    try {
      const queueState = cloneQueueState(await combat.getFlag(MODULE_ID, QUEUED_CHOICES_FLAG));
      if (side && queueState?.[side] === combatantId) {
        const updated = { ...queueState, [side]: null };
        await applyQueuedChoiceFlags(combat, updated);
      }
    } catch (err) {
      log(err);
    }
  }

  if (typeof combat.setTurn === "function") {
    await combat.setTurn(combatantId);
  } else {
    const idx = combat.turns.findIndex((c) => c.id === combatantId);
    if (idx < 0) throw new Error("Combatant missing from turn order.");
    await combat.update({ turn: idx });
  }

  return { side };
}

export async function applyQueuedChoiceFlags(combat, queue) {
  const normalized = cloneQueueState(queue);
  if (!combat) return normalized;
  if (isQueueEmpty(normalized)) {
    await combat.unsetFlag(MODULE_ID, QUEUED_CHOICES_FLAG);
  } else {
    await combat.setFlag(MODULE_ID, QUEUED_CHOICES_FLAG, normalized);
  }
  await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  return normalized;
}

async function processSocketAction(action, data = {}) {
  switch (action) {
    case "queue:set": {
      const combatId = data?.combatId ?? null;
      if (!combatId) throw new Error("Missing combat identifier.");
      const combat = resolveCombatById(combatId);
      if (!combat) throw new Error("Combat not found.");
      const queue = cloneQueueState(data?.queue);
      await applyQueuedChoiceFlags(combat, queue);
      return { queue };
    }
    case "combat:nextTurn": {
      const combatId = data?.combatId ?? null;
      if (!combatId) throw new Error("Missing combat identifier.");
      const combat = resolveCombatById(combatId);
      if (!combat) throw new Error("Combat not found.");
      const bypassQueuePrompt = data?.bypassQueuePrompt === true;
      if (bypassQueuePrompt) queuePromptBypass.add(combatId);
      try {
        await combat.nextTurn();
      } finally {
        if (bypassQueuePrompt) queuePromptBypass.delete(combatId);
      }
      return {};
    }
    case "combat:setTurn": {
      const combatId = data?.combatId ?? null;
      const combatantId = data?.combatantId ?? null;
      if (!combatId) throw new Error("Missing combat identifier.");
      const combat = resolveCombatById(combatId);
      if (!combat) throw new Error("Combat not found.");
      return applyImmediateActivation(combat, combatantId, data?.side ?? null);
    }
    default:
      throw new Error(`Unknown socket action: ${action}`);
  }
}

export async function sendSocketRequest(action, data = {}, { timeout = SOCKET_TIMEOUT_MS } = {}) {
  if (!socketBridgeInitialized) registerSocketBridge();
  if (game.user.isGM) {
    return processSocketAction(action, data);
  }

  if (!game.socket) throw new Error("Socket channel unavailable.");
  const hasActiveGm = game.users?.some?.((u) => u?.isGM && u.active);
  if (!hasActiveGm) throw new Error("No active GM to process request.");

  const requestId = generateSocketRequestId();
  const payload = { requestId, action, data, userId: game.user.id };

  return new Promise((resolve, reject) => {
    const timeoutId = (globalThis.setTimeout ?? setTimeout)(() => {
      pendingSocketRequests.delete(requestId);
      reject(new Error("GM request timed out."));
    }, timeout);

    pendingSocketRequests.set(requestId, { resolve, reject, timeoutId });
    game.socket.emit(SOCKET_EVENT, payload);
  });
}

export function registerSocketBridge() {
  if (socketBridgeInitialized) return;

  const socket = game.socket;
  if (!socket) {
    if (socketBridgeRetryTimer === null) {
      const delay = Math.max(100, Math.min(2000, SOCKET_TIMEOUT_MS / 4));
      socketBridgeRetryTimer = (globalThis.setTimeout ?? setTimeout)(() => {
        socketBridgeRetryTimer = null;
        registerSocketBridge();
      }, delay);
    }
    return;
  }

  socketBridgeInitialized = true;
  socketBridgeRetryTimer = null;

  socket.on(SOCKET_EVENT, async (payload = {}) => {
    if (payload?.response) {
      handleSocketResponse(payload);
      return;
    }

    if (!game.user.isGM) return;

    const requestId = payload.requestId;
    try {
      const result = await processSocketAction(payload.action, payload.data ?? {});
      if (requestId) {
        socket.emit(SOCKET_EVENT, {
          response: true,
          requestId,
          success: true,
          result
        });
      }
    } catch (err) {
      if (requestId) {
        socket.emit(SOCKET_EVENT, {
          response: true,
          requestId,
          success: false,
          error: err?.message ?? err
        });
      }
      log(err);
    }
  });
}

export async function persistQueuedChoices(combat, queue) {
  const normalized = cloneQueueState(queue);
  if (!combat) return normalized;

  const isOwner = game.user.isGM || hasDocumentPermission(combat, OWNER_LEVEL);
  if (isOwner) {
    await applyQueuedChoiceFlags(combat, normalized);
    return normalized;
  }

  try {
    await sendSocketRequest("queue:set", { combatId: combat.id, queue: normalized });
    return normalized;
  } catch (err) {
    const enriched = handleSocketFailure("Failed to update the queue.", err);
    throw enriched;
  }
}

export async function advanceCombatTurn(combat, { bypassQueuePrompt = false } = {}) {
  if (!combat) return;

  const combatId = combat.id;
  const bypass = bypassQueuePrompt === true;
  const performNextTurn = async () => {
    if (bypass && combatId) queuePromptBypass.add(combatId);
    try {
      await combat.nextTurn();
    } finally {
      if (bypass && combatId) queuePromptBypass.delete(combatId);
    }
  };

  const isOwner = game.user.isGM || hasDocumentPermission(combat, OWNER_LEVEL);
  if (isOwner) {
    await performNextTurn();
    return;
  }

  if (bypass && combatId) queuePromptBypass.add(combatId);
  try {
    await sendSocketRequest("combat:nextTurn", { combatId, bypassQueuePrompt: bypass });
    return;
  } catch (err) {
    const enriched = handleSocketFailure("Failed to advance the turn.", err);
    throw enriched;
  } finally {
    if (bypass && combatId) queuePromptBypass.delete(combatId);
  }
}

export async function activateCombatant(combat, combatantId, { side = null } = {}) {
  if (!combat || !combatantId) return;

  const combatId = combat.id;
  const performActivation = () => applyImmediateActivation(combat, combatantId, side);

  const isOwner = game.user.isGM || hasDocumentPermission(combat, OWNER_LEVEL);
  if (isOwner) {
    await performActivation();
    return;
  }

  try {
    await sendSocketRequest("combat:setTurn", { combatId, combatantId, side });
    return;
  } catch (err) {
    const enriched = handleSocketFailure("Failed to activate the combatant.", err);
    throw enriched;
  }
}

export async function readQueuedChoices(combat, entries = []) {
  const raw = await combat.getFlag(MODULE_ID, QUEUED_CHOICES_FLAG);
  let queue = cloneQueueState(raw);

  const legacy = await combat.getFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  if (legacy) {
    const legacyChanged = new Set();
    let side = null;
    const entry = entries.find((e) => e.id === legacy);
    if (entry) {
      side = entry.side;
    } else {
      const doc = combat.combatants?.get?.(legacy);
      if (doc) side = isPC(doc) ? "pc" : "npc";
    }

    if (side && !queue[side]) {
      queue = { ...queue, [side]: legacy };
      legacyChanged.add(side);
    }

    if (game.user.isGM) {
      if (legacyChanged.size) {
        await persistQueuedChoices(combat, queue);
      }
      await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
    }
  }

  const mappedEntries = new Map();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry?.id) continue;
      mappedEntries.set(entry.id, entry);
    }
  }

  if (!mappedEntries.size && combat?.combatants) {
    const combatants = combat.combatants;
    if (typeof combatants?.forEach === "function") {
      combatants.forEach((value) => {
        if (!value?.id) return;
        mappedEntries.set(value.id, value);
      });
    } else if (Array.isArray(combatants)) {
      for (const entry of combatants) {
        if (!entry?.id) continue;
        mappedEntries.set(entry.id, entry);
      }
    }
  }

  let dirty = false;

  for (const side of ["pc", "npc"]) {
    const queuedId = queue[side];
    if (!queuedId) continue;

    const entry = mappedEntries.get(queuedId) ?? null;
    if (!entry) {
      queue = { ...queue, [side]: null };
      dirty = true;
      continue;
    }

    const entrySide = entry.side ?? (isPC(entry) ? "pc" : "npc");
    if (entrySide !== side) {
      queue = { ...queue, [side]: null };
      dirty = true;
      continue;
    }

    const defeated = entry.isDefeated ?? entry.defeated ?? false;
    const acted = entry.acted ?? false;
    const complete = entry.isComplete === true || isCombatantComplete(entry, combat);
    if (defeated || acted || complete) {
      queue = { ...queue, [side]: null };
      dirty = true;
    }
  }

  if (dirty) {
    try {
      await persistQueuedChoices(combat, queue);
    } catch (err) {
      log(err);
    }
  }

  return queue;
}

export async function updateQueuedChoice(combat, side, combatantId) {
  if (!combat || !["pc", "npc"].includes(side)) return emptyQueue();
  const current = await readQueuedChoices(combat);
  const nextId = combatantId ?? null;
  if (current[side] === nextId) return current;
  const next = { ...current, [side]: nextId };
  await persistQueuedChoices(combat, next);
  return next;
}

export async function clearQueuedChoice(combat, side = null) {
  if (!combat) return;
  const current = await readQueuedChoices(combat);
  let changed = false;

  if (side && ["pc", "npc"].includes(side)) {
    if (current[side]) {
      current[side] = null;
      changed = true;
    }
  } else if (current.pc || current.npc) {
    current.pc = null;
    current.npc = null;
    changed = true;
  }

  if (changed) await persistQueuedChoices(combat, current);
}

export function cloneDisplayGroup(group) {
  return {
    pc: [...(group?.pc ?? [])],
    npc: [...(group?.npc ?? [])]
  };
}
