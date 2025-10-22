/*******************************************************************************************
 * Wrath & Glory — Zipper Initiative for Foundry VTT
 * Author: Ariel Cember + GPT-5
 * Version: 0.3.0
 * 
 * Implements strict alternate-activation (PC↔NPC) initiative with PCs always leading each round.
 * When multiple PCs are eligible, players choose who acts next.
 * GM always retains override authority. Falls back to default Foundry initiative if disabled.
 *******************************************************************************************/

const MODULE_ID = "wng-zipper-initiative";
const MANUAL_CHOICE_FLAG = "manualChoice";
const QUEUED_CHOICES_FLAG = "queuedChoices";
const DOCK_TEMPLATE = "templates/zipper-tracker.hbs";
const DOCK_WRAPPER_CLASS = "wng-zipper-tracker-container";
const DOCK_ROOT_ID = "wng-zipper-dock";
const DOCK_DEFAULTS = {
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

const DOCK_SIZE_LIMITS = {
  width: { min: 200, max: 1200 },
  height: { min: 220, max: 2200 }
};

const DOCK_OVERRIDE_STORAGE_KEY = `${MODULE_ID}.dockOverrides`;

const SOCKET_EVENT = `module.${MODULE_ID}`;
const SOCKET_TIMEOUT_MS = 8000;
const pendingSocketRequests = new Map();
let socketBridgeInitialized = false;
let socketBridgeRetryTimer = null;
let dockOverrideCache = null;

/* ---------------------------------------------------------
 * Utility helpers
 * --------------------------------------------------------- */
const log = (...args) => console.log(`[%c${MODULE_ID}%c]`, "color:#2ea043", "color:inherit", ...args);

function canPersistDockSettings() {
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

function getDockOverrides() {
  if (!dockOverrideCache) {
    dockOverrideCache = readDockOverrideStorage();
  }
  return { ...(dockOverrideCache ?? {}) };
}

function updateDockOverrides(partial = {}) {
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

function clearDockOverrides(keys = null) {
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
const isPC = (c) => {
  try {
    if (!c) return false;
    // Prefer actor ownership; fallback to token disposition (FRIENDLY=1)
    if (typeof c.actor?.hasPlayerOwner === "boolean") return c.actor.hasPlayerOwner;
    const disp = c.token?.disposition ?? c.token?.document?.disposition;
    return disp === 1; // FRIENDLY
  } catch {
    return false;
  }
};

const STATUS_LABELS = {
  pending: "Pending",
  current: "Current",
  complete: "Complete",
  defeated: "Defeated"
};

const formatStatusLabel = (status, entry) => {
  if (entry?.isDefeated) return STATUS_LABELS.defeated;
  if (status && STATUS_LABELS[status]) return STATUS_LABELS[status];
  if (entry?.acted) return "Acted";
  return "Ready";
};

const sanitizeEntry = (entry, selectedId) => {
  const statusLabel = formatStatusLabel(entry.status, entry);
  const doc = entry?.doc;
  const actor = doc?.actor;
  const isOwner = doc?.isOwner ?? actor?.isOwner ?? false;
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
    isOwner
  };
};

function isCombatantComplete(entry, combat = null) {
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

const emptyQueue = () => ({ pc: null, npc: null });
const queuePromptBypass = new Set();

const cloneQueueState = (queue) => ({
  pc: typeof queue?.pc === "string" && queue.pc.length ? queue.pc : null,
  npc: typeof queue?.npc === "string" && queue.npc.length ? queue.npc : null
});

const isQueueEmpty = (queue) => !(queue?.pc || queue?.npc);

function resolveCombatById(combatId) {
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

async function applyQueuedChoiceFlags(combat, queue) {
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
    default:
      throw new Error(`Unknown socket action: ${action}`);
  }
}

async function sendSocketRequest(action, data = {}, { timeout = SOCKET_TIMEOUT_MS } = {}) {
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

function registerSocketBridge() {
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

async function persistQueuedChoices(combat, queue) {
  const normalized = cloneQueueState(queue);
  if (!combat) return normalized;

  if (game.user.isGM) {
    await applyQueuedChoiceFlags(combat, normalized);
    return normalized;
  }

  try {
    await sendSocketRequest("queue:set", { combatId: combat.id, queue: normalized });
    return normalized;
  } catch (err) {
    log(err);
    ui.notifications?.error?.("Failed to update the queued combatant. Please ask the GM to try again.");
    throw err;
  }
}

async function readQueuedChoices(combat, entries = []) {
  const raw = await combat.getFlag(MODULE_ID, QUEUED_CHOICES_FLAG);
  let queue = cloneQueueState(raw);

  const legacy = await combat.getFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  if (legacy) {
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
    }

    if (game.user.isGM) {
      await persistQueuedChoices(combat, queue);
      await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
    }
  }

  return queue;
}

async function updateQueuedChoice(combat, side, combatantId) {
  if (!combat || !["pc", "npc"].includes(side)) return emptyQueue();
  const current = await readQueuedChoices(combat);
  const nextId = combatantId ?? null;
  if (current[side] === nextId) return current;
  const next = { ...current, [side]: nextId };
  await persistQueuedChoices(combat, next);
  return next;
}

async function clearQueuedChoice(combat, side = null) {
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

const canActivateEntry = (entry, nextSide, allowPlayers) => {
  if (!entry) return false;
  if (nextSide && entry.side !== nextSide) return false;
  if (entry.side === "npc") return game.user.isGM;
  return game.user.isGM || allowPlayers;
};

const canQueueEntry = (entry, nextSide, currentSide, allowPlayers, { combatStarted = true } = {}) => {
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
    if (!entry.isOwner) return false;
    if (combatStarted && currentSide !== "npc") return false;
    return true;
  }

  return false;
};

const SIDE_LABELS = {
  pc: "PCs",
  npc: "NPCs"
};

const toSideLabel = (side) => SIDE_LABELS[side] ?? null;

const clamp = (value, min, max) => {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
};

function readNumericSetting(key, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = Number(game.settings.get(MODULE_ID, key));
  if (Number.isFinite(raw)) return clamp(raw, min, max);
  return clamp(Number(fallback) || 0, min, max);
}

function readOpacitySetting(key, fallback) {
  const numeric = Number(game.settings.get(MODULE_ID, key));
  if (Number.isFinite(numeric)) return clamp(numeric, 0, 1);
  return clamp(Number(fallback) || 0, 0, 1);
}

function getDockStyleConfig() {
  const anchorSetting = game.settings.get(MODULE_ID, "dockAnchor") ?? DOCK_DEFAULTS.anchor;
  let anchor = anchorSetting === "left" ? "left" : "right";
  let topOffset = readNumericSetting("dockTopOffset", DOCK_DEFAULTS.topOffset, { min: 0, max: 2000 });
  let sideOffset = readNumericSetting("dockSideOffset", DOCK_DEFAULTS.sideOffset, { min: 0, max: 2000 });
  let width = readNumericSetting("dockWidth", DOCK_DEFAULTS.width, { min: DOCK_SIZE_LIMITS.width.min, max: DOCK_SIZE_LIMITS.width.max });
  let heightSetting = readNumericSetting("dockHeight", DOCK_DEFAULTS.height, { min: 0, max: DOCK_SIZE_LIMITS.height.max });
  const buffer = readNumericSetting("dockMaxHeightBuffer", DOCK_DEFAULTS.maxHeightBuffer, { min: 0, max: 2000 });
  const inactiveOpacity = readOpacitySetting("dockInactiveOpacity", DOCK_DEFAULTS.inactiveOpacity);
  const noCombatOpacity = readOpacitySetting("dockNoCombatOpacity", DOCK_DEFAULTS.noCombatOpacity);
  const backgroundOpacity = readOpacitySetting("dockBackgroundOpacity", DOCK_DEFAULTS.backgroundOpacity);
  const overrides = getDockOverrides();

  if (overrides.anchor === "left" || overrides.anchor === "right") {
    anchor = overrides.anchor;
  }
  if (Number.isFinite(overrides.top)) {
    topOffset = clamp(overrides.top, 0, 2000);
  }
  if (Number.isFinite(overrides.side)) {
    sideOffset = clamp(overrides.side, 0, 2000);
  }
  if (Number.isFinite(overrides.width)) {
    width = clamp(overrides.width, DOCK_SIZE_LIMITS.width.min, DOCK_SIZE_LIMITS.width.max);
  }
  if (overrides.height === 0) {
    heightSetting = 0;
  } else if (Number.isFinite(overrides.height)) {
    heightSetting = clamp(overrides.height, DOCK_SIZE_LIMITS.height.min, DOCK_SIZE_LIMITS.height.max);
  }

  if (heightSetting > 0) {
    const viewportHeight = window?.innerHeight ?? null;
    if (Number.isFinite(viewportHeight)) {
      const available = clamp(viewportHeight - buffer, DOCK_SIZE_LIMITS.height.min, DOCK_SIZE_LIMITS.height.max);
      heightSetting = clamp(heightSetting, DOCK_SIZE_LIMITS.height.min, available);
    }
  }

  return {
    anchor,
    top: `${topOffset}px`,
    side: `${sideOffset}px`,
    width: `${width}px`,
    maxHeight: `calc(100vh - ${buffer}px)`,
    height: heightSetting > 0 ? `${heightSetting}px` : null,
    inactiveOpacity: inactiveOpacity.toFixed(2),
    noCombatOpacity: noCombatOpacity.toFixed(2),
    backgroundOpacity: backgroundOpacity.toFixed(2),
    isLeft: anchor === "left",
    isRight: anchor === "right"
  };
}

const cloneDisplayGroup = (group) => ({
  pc: [...(group?.pc ?? [])],
  npc: [...(group?.npc ?? [])]
});

const PLAYERS_SIDE = "pc";

async function ensurePlayersLead(combat, { resetActed = false, resetCurrentSide = false } = {}) {
  if (!combat) return;
  if (!game.user?.isGM) return;

  const updates = [];
  try {
    const startingSide = await combat.getFlag(MODULE_ID, "startingSide");
    if (startingSide !== PLAYERS_SIDE) {
      updates.push(combat.setFlag(MODULE_ID, "startingSide", PLAYERS_SIDE));
    }
  } catch (err) {
    log(err);
  }

  if (resetActed) {
    updates.push(combat.setFlag(MODULE_ID, "actedIds", []));
  }
  if (resetCurrentSide) {
    updates.push(combat.setFlag(MODULE_ID, "currentSide", PLAYERS_SIDE));
  }

  if (!updates.length) return;

  try {
    await Promise.all(updates);
  } catch (err) {
    log(err);
  }
}

async function getStartingSide(combat) {
  if (!combat) return PLAYERS_SIDE;
  let startingSide = PLAYERS_SIDE;
  try {
    const stored = await combat.getFlag(MODULE_ID, "startingSide");
    if (stored === PLAYERS_SIDE) return PLAYERS_SIDE;
    startingSide = PLAYERS_SIDE;
    if (game.user?.isGM) {
      try {
        await combat.setFlag(MODULE_ID, "startingSide", PLAYERS_SIDE);
      } catch (err) {
        log(err);
      }
    }
  } catch (err) {
    log(err);
  }
  return startingSide;
}

async function evaluateZipperState(combat, opts = {}) {
  const preview = !!opts.preview;
  const forceStart = !!opts.forceStartOfRound;
  const enabled = await combat.getFlag(MODULE_ID, "enabled");
  const startingSide = await getStartingSide(combat);
  const currentSideFlag = forceStart ? null : await combat.getFlag(MODULE_ID, "currentSide");
  const plan = {
    preview,
    enabled,
    state: {
      startingSide,
      currentSide: currentSideFlag,
      actedIds: [],
      queue: emptyQueue(),
      nextSide: null,
      upcomingSide: null
    },
    entries: [],
    options: [],
    display: {
      ready: { pc: [], npc: [] },
      spent: { pc: [], npc: [] },
      defeated: { pc: [], npc: [] },
      current: null,
      nextCandidates: [],
      nextSide: null,
      upcomingSide: null,
      queue: { pc: null, npc: null }
    },
    choice: null,
    queueConsumedSide: null,
    needsChoice: false,
    clearActed: !!forceStart,
    roundReset: false,
    roundResetMessage: null,
    announceMessage: null,
    allowPlayers: game.settings.get(MODULE_ID, "playersCanAdvance")
  };

  if (!enabled) return plan;

  const turns = combat.turns || [];
  if (!turns.length) return plan;

  const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
  if (forceStart) acted.clear();
  plan.state.actedIds = Array.from(acted);

  const entries = turns.map((turn, index) => {
    const doc = combat.combatants.get(turn.id) ?? turn;
    const status = doc?.getFlag?.("wrath-and-glory", "combatStatus") ?? null;
    const isDefeated = doc?.isDefeated ?? turn.isDefeated ?? turn.defeated ?? false;
    const hidden = !!(turn.hidden ?? doc?.hidden);
    const entry = {
      id: turn.id,
      index,
      name: turn.name,
      img: turn.token?.texture?.src || turn.img,
      side: isPC(turn) ? "pc" : "npc",
      acted: acted.has(turn.id),
      isCurrent: combat.combatant?.id === turn.id,
      isPending: doc?.isPending ?? status === "pending",
      isComplete: doc?.isComplete ?? status === "complete",
      isDefeated,
      status,
      hidden,
      doc
    };
    return entry;
  });

  plan.entries = entries;

  const queueState = await readQueuedChoices(combat, entries);
  plan.state.queue = cloneQueueState(queueState);

  const visibleEntries = entries.filter(e => !e.hidden || game.user.isGM);
  const available = (side, set = acted) => entries.filter((e) => {
    if (e.side !== side) return false;
    if (e.isDefeated) return false;
    if (e.isComplete) return false;
    if (e.acted) return false;
    if (set.has(e.id)) return false;
    if (e.hidden && !game.user.isGM) return false;
    return true;
  });
  const freshPool = (side) => entries.filter((e) => {
    if (e.side !== side) return false;
    if (e.isDefeated) return false;
    if (e.isComplete) return false;
    if (e.hidden && !game.user.isGM) return false;
    return true;
  });

  const pcAvail = available("pc", acted);
  const npcAvail = available("npc", acted);

  const previousSide = forceStart ? null : plan.state.currentSide;
  let options = [];
  let choice = null;
  const queueEntries = { pc: null, npc: null };

  for (const side of ["pc", "npc"]) {
    const queuedId = plan.state.queue[side];
    if (!queuedId) continue;
    const queuedEntry = entries.find((e) => e.id === queuedId);
    if (!queuedEntry || queuedEntry.side !== side) {
      plan.state.queue[side] = null;
      continue;
    }
    if (queuedEntry.isDefeated) {
      plan.state.queue[side] = null;
      continue;
    }
    if (queuedEntry.acted || queuedEntry.isComplete) {
      plan.state.queue[side] = null;
      continue;
    }
    queueEntries[side] = queuedEntry;
    if (!queuedEntry.hidden || game.user.isGM) {
      plan.display.queue[side] = sanitizeEntry(queuedEntry, queuedId);
    }
  }

  const resolveNextSide = () => {
    if (previousSide === "pc") return "npc";
    if (previousSide === "npc") return "pc";
    return plan.state.startingSide;
  };

  const queuedForSide = (side) => {
    const entry = queueEntries[side];
    if (!entry) return null;
    if (entry.isDefeated) return null;
    if (entry.isComplete) return null;
    if (entry.acted || acted.has(entry.id)) return null;
    return entry;
  };

  let nextSide = resolveNextSide();
  let queuedNext = null;

  if (!pcAvail.length && !npcAvail.length) {
    plan.roundReset = true;
    plan.clearActed = true;
    nextSide = plan.state.startingSide;
    queuedNext = queuedForSide(nextSide);
    options = freshPool(plan.state.startingSide);
    choice = queuedNext ?? options[0] ?? null;
    if (queuedNext) {
      plan.queueConsumedSide = nextSide;
    }
    if (choice) {
      const nextLabel = toSideLabel(nextSide) ?? nextSide.toUpperCase();
      plan.roundResetMessage = `<strong>Zipper:</strong> All combatants acted. New round begins with <em>${nextLabel}</em>.`;
    }
    plan.display.upcomingSide = nextSide;
  } else {
    if (nextSide === "pc" && !pcAvail.length) nextSide = "npc";
    if (nextSide === "npc" && !npcAvail.length) nextSide = "pc";

    options = nextSide === "pc" ? pcAvail : npcAvail;
    if (options.length) {
      queuedNext = queuedForSide(nextSide);
      if (queuedNext) {
        choice = queuedNext;
        plan.queueConsumedSide = nextSide;
      } else {
        const needsChoice = nextSide === "pc" && plan.allowPlayers && options.length > 1;
        plan.needsChoice = needsChoice;
        if (!needsChoice) {
          choice = options[0];
        }
      }

      const opposingHasOptions = nextSide === "pc" ? npcAvail.length > 0 : pcAvail.length > 0;
      plan.display.upcomingSide = opposingHasOptions ? (nextSide === "pc" ? "npc" : "pc") : nextSide;
      if (!plan.roundReset) {
        plan.announceMessage = `<em>Alternate Activation:</em> <strong>${nextSide.toUpperCase()}</strong> act.`;
      }
    }
  }

  plan.options = options;
  plan.choice = choice;
  const effectiveNextSide = (options.length || queuedNext) ? nextSide : null;
  plan.display.nextSide = effectiveNextSide;
  plan.display.nextCandidates = options
    .filter(e => !e.hidden || game.user.isGM)
    .map((e) => {
      const sanitized = sanitizeEntry(e, plan.state.queue[e.side]);
      sanitized.canActivate = canActivateEntry(sanitized, effectiveNextSide, plan.allowPlayers);
      return sanitized;
    });
  const currentVisible = visibleEntries.find(e => e.isCurrent) ?? null;
  plan.display.current = currentVisible ? sanitizeEntry(currentVisible, plan.state.queue[currentVisible.side]) : null;

  for (const entry of visibleEntries) {
    const sanitized = sanitizeEntry(entry, plan.state.queue[entry.side]);
    if (entry.isDefeated) {
      plan.display.defeated[entry.side].push(sanitized);
      continue;
    }
    if (entry.acted || entry.isComplete) {
      plan.display.spent[entry.side].push(sanitized);
    } else {
      plan.display.ready[entry.side].push(sanitized);
    }
  }

  plan.state.nextSide = plan.display.nextSide;
  plan.state.upcomingSide = plan.display.upcomingSide;

  return plan;
}

/* ---------------------------------------------------------
 * Settings
 * --------------------------------------------------------- */
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabledByDefault", {
    name: "Enable by default for new Combats",
    hint: "When true, new combats will start with zipper initiative turned on.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "playersCanAdvance", {
    name: "Allow players to choose next PC",
    hint: "Allow players to select the next PC when it's their side's activation.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "dockAnchor", {
    name: "Dock Anchor Side",
    hint: "Choose which side of the screen the zipper dock should attach to.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      right: "Right",
      left: "Left"
    },
    default: DOCK_DEFAULTS.anchor,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockTopOffset", {
    name: "Dock Top Offset (px)",
    hint: "Distance from the top edge of the screen in pixels.",
    scope: "client",
    config: true,
    type: Number,
    default: DOCK_DEFAULTS.topOffset,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockSideOffset", {
    name: "Dock Side Offset (px)",
    hint: "Horizontal distance from the anchored edge in pixels.",
    scope: "client",
    config: true,
    type: Number,
    default: DOCK_DEFAULTS.sideOffset,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockWidth", {
    name: "Dock Width (px)",
    hint: "Overall width of the zipper dock in pixels.",
    scope: "client",
    config: true,
    type: Number,
    default: DOCK_DEFAULTS.width,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockHeight", {
    name: "Dock Height (px)",
    hint: "Fixed height of the zipper dock in pixels. Set to 0 to auto-size to the viewport buffer.",
    scope: "client",
    config: true,
    type: Number,
    default: DOCK_DEFAULTS.height,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockMaxHeightBuffer", {
    name: "Dock Max Height Buffer (px)",
    hint: "Pixels to subtract from the viewport height when calculating the dock's max height.",
    scope: "client",
    config: true,
    type: Number,
    default: DOCK_DEFAULTS.maxHeightBuffer,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockInactiveOpacity", {
    name: "Inactive Dock Opacity",
    hint: "Opacity of the dock when zipper initiative is disabled (0–1).",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: DOCK_DEFAULTS.inactiveOpacity,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockNoCombatOpacity", {
    name: "No-Combat Dock Opacity",
    hint: "Opacity of the dock when no combat is selected (0–1).",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: DOCK_DEFAULTS.noCombatOpacity,
    onChange: () => requestDockRender()
  });

  game.settings.register(MODULE_ID, "dockBackgroundOpacity", {
    name: "Dock Background Opacity",
    hint: "Opacity of the dock panel background (0–1).",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: DOCK_DEFAULTS.backgroundOpacity,
    onChange: () => requestDockRender()
  });
});

/* ---------------------------------------------------------
 * Combat Tracker Header Buttons
 * --------------------------------------------------------- */
Hooks.on("getCombatTrackerHeaderButtons", (app, buttons) => {
  const combat = game.combat;
  const enabled = combat?.getFlag(MODULE_ID, "enabled") ?? false;

  buttons.unshift({
    label: enabled ? "Zipper: ON" : "Zipper: OFF",
    class: enabled ? "zipper-on" : "zipper-off",
    icon: enabled ? "fas fa-exchange-alt" : "far fa-exchange-alt",
    onclick: async () => {
      if (!combat) return ui.notifications.warn("No active combat.");
      const now = !!(combat.getFlag(MODULE_ID, "enabled"));
      const next = !now;
      await combat.setFlag(MODULE_ID, "enabled", next);
      if (next) {
        await ensurePlayersLead(combat, { resetActed: true, resetCurrentSide: true });
      }
      app.render();
    }
  });

});

/* ---------------------------------------------------------
 * Initialize per-combat defaults
 * --------------------------------------------------------- */
Hooks.on("createCombat", async (combat) => {
  try {
    const auto = game.settings.get(MODULE_ID, "enabledByDefault");
    await combat.setFlag(MODULE_ID, "enabled", !!auto);
    await combat.setFlag(MODULE_ID, "actedIds", []);
    await combat.setFlag(MODULE_ID, "currentSide", auto ? PLAYERS_SIDE : null);
    if (game.user?.isGM) {
      try {
        await combat.setFlag(MODULE_ID, "startingSide", PLAYERS_SIDE);
      } catch (err) {
        log(err);
      }
    }
    await ensurePlayersLead(combat);
  } catch (e) { log(e); }
});

/* ---------------------------------------------------------
 * Reset acted list on new round
 * --------------------------------------------------------- */
Hooks.on("updateCombat", async (combat, change) => {
  try {
    if (!combat?.getFlag(MODULE_ID, "enabled")) return;
    if (typeof change.round === "number") {
      await combat.setFlag(MODULE_ID, "actedIds", []);
      await ensurePlayersLead(combat, { resetCurrentSide: true });
      const firstLabel = toSideLabel(PLAYERS_SIDE) ?? "PCs";
      await ChatMessage.create({
        content: `<strong>Zipper:</strong> New round started. <em>${firstLabel}</em> act first.`,
        whisper: ChatMessage.getWhisperRecipients("GM")
      });
    }
  } catch (e) { log(e); }
});

/* ---------------------------------------------------------
 * Track who just acted (turn end)
 * --------------------------------------------------------- */
Hooks.on("combatTurn", async (combat, turn, options) => {
  try {
    if (!combat?.getFlag(MODULE_ID, "enabled")) return;
    const prevData = options?.prev ?? combat.previous ?? {};
    const prevId = prevData?.id ?? prevData?.combatantId;
    const prevRound = prevData?.round;
    if (prevId && (prevRound === undefined || prevRound === combat.round)) {
      const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
      acted.add(prevId);
      await combat.setFlag(MODULE_ID, "actedIds", Array.from(acted));
    }
  } catch (e) { log(e); }
});

/* ---------------------------------------------------------
 * Core zipper behavior
 * --------------------------------------------------------- */
Hooks.once("ready", async () => {
  // Wrap Combat.nextTurn / nextRound
  const wrap = (klass, method, impl) => {
    const original = klass.prototype[method];
    klass.prototype[method] = async function (...args) {
      try {
        return await impl.call(this, original.bind(this), ...args);
      } catch (e) {
        log(e);
        return await original.apply(this, args);
      }
    };
  };

  // Resolve the Combat document constructor across Foundry versions.
  const combatDocumentClass =
    game.getDocumentClass?.("Combat")
    ?? game.combats?.documentClass
    ?? game.documents?.getConstructor?.("Combat")
    ?? CONFIG?.Combat?.documentClass;

  const C = combatDocumentClass;
  if (!C) {
    log("Unable to resolve Combat document constructor; aborting zipper initialization.");
    return;
  }

  wrap(C, "nextTurn", async function (original, ...args) {
    if (!(await this.getFlag(MODULE_ID, "enabled"))) return original(...args);
    const current = this.combatant ?? null;
    if (queuePromptBypass.has(this.id)) {
      queuePromptBypass.delete(this.id);
    } else {
      const outcome = await maybePromptForNextPcQueue(this, { actingCombatant: current });
      if (outcome.cancelled) return this;
    }
    const nextCombatant = await computeNextZipperCombatant(this);
    if (!nextCombatant) return original(...args);

    if (typeof this.setTurn === "function") {
      return this.setTurn(nextCombatant.id);
    }

    const idx = this.turns.findIndex(t => t.id === nextCombatant.id);
    if (idx < 0) return original(...args);
    return this.update({ turn: idx });
  });

  wrap(C, "nextRound", async function (original, ...args) {
    if (!(await this.getFlag(MODULE_ID, "enabled"))) return original(...args);

    const outcome = await original(...args);
    const nextCombatant = await computeNextZipperCombatant(this, { forceStartOfRound: true });
    if (!nextCombatant) return outcome;

    if (typeof this.setTurn === "function") {
      await this.setTurn(nextCombatant.id);
      return this;
    }

    const idx = this.turns.findIndex(t => t.id === nextCombatant.id);
    if (idx < 0) return outcome;
    await this.update({ turn: idx });
    return this;
  });
});

/* ---------------------------------------------------------
 * Strict alternation (PC↔NPC)
 * --------------------------------------------------------- */
async function computeNextZipperCombatant(combat, opts = {}) {
  const enabled = await combat.getFlag(MODULE_ID, "enabled");
  if (!enabled) return null;
  const turns = combat.turns || [];
  if (!turns.length) return null;

  const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
  if (opts.forceStartOfRound) acted.clear();
  const startingSide = await getStartingSide(combat);
  const previousSide = opts.forceStartOfRound ? null : await combat.getFlag(MODULE_ID, "currentSide");

  const queueState = await readQueuedChoices(combat, turns);
  const queue = cloneQueueState(queueState);
  const queueEntries = { pc: null, npc: null };
  let queueChanged = false;

  for (const side of ["pc", "npc"]) {
    const queuedId = queue[side];
    if (!queuedId) continue;
    const entry = turns.find((c) => c.id === queuedId);
    if (!entry) {
      queue[side] = null;
      queueChanged = true;
      continue;
    }
    const entrySide = isPC(entry) ? "pc" : "npc";
    if (entrySide !== side) {
      queue[side] = null;
      queueChanged = true;
      continue;
    }
    const defeated = entry.isDefeated ?? entry.defeated ?? false;
    const complete = isCombatantComplete(entry, combat);
    if (defeated || complete || acted.has(entry.id)) {
      queue[side] = null;
      queueChanged = true;
      continue;
    }
    queueEntries[side] = entry;
  }

  const aliveAvailOfSide = (side) => turns.filter((c) => {
    const defeated = c.isDefeated ?? c.defeated ?? false;
    if (defeated) return false;
    if (isCombatantComplete(c, combat)) return false;
    if (c.hidden && !game.user.isGM) return false;
    return (side === "pc") === isPC(c) && !acted.has(c.id);
  });

  const pcAvail = aliveAvailOfSide("pc");
  const npcAvail = aliveAvailOfSide("npc");

  const resolveNextSide = () => {
    if (previousSide === "pc") return "npc";
    if (previousSide === "npc") return "pc";
    return startingSide;
  };

  let nextSide = resolveNextSide();
  let queuedNext = null;

  if (!pcAvail.length && !npcAvail.length) {
    await combat.setFlag(MODULE_ID, "actedIds", []);
    await ensurePlayersLead(combat, { resetCurrentSide: true });
    if (queueChanged) await persistQueuedChoices(combat, queue);
    const fresh = aliveAvailOfSide(startingSide);
    if (!fresh.length) return null;
    ChatMessage.create({
      content: `<strong>Zipper:</strong> All combatants acted. New round begins with <em>${(toSideLabel(startingSide) ?? "PCs")}</em>.`,
      whisper: ChatMessage.getWhisperRecipients("GM")
    });
    return fresh[0];
  }

  if (nextSide === "pc" && !pcAvail.length) nextSide = "npc";
  if (nextSide === "npc" && !npcAvail.length) nextSide = "pc";

  let candidates = nextSide === "pc" ? pcAvail : npcAvail;
  const queuedCandidate = queueEntries[nextSide];
  if (queuedCandidate && candidates.some((c) => c.id === queuedCandidate.id)) {
    queuedNext = queuedCandidate;
  }

  let chosen = null;
  if (queuedNext) {
    chosen = queuedNext;
    queue[nextSide] = null;
    queueChanged = true;
  } else if (candidates.length) {
    chosen = candidates[0];
  } else if (queuedCandidate) {
    chosen = queuedCandidate;
    queue[nextSide] = null;
    queueChanged = true;
  }

  if (!chosen) return null;

  const chosenSide = isPC(chosen) ? "pc" : "npc";
  await combat.setFlag(MODULE_ID, "currentSide", chosenSide);
  if (queueChanged) await persistQueuedChoices(combat, queue);

  await ChatMessage.create({
    content: `<em>Alternate Activation:</em> <strong>${chosenSide.toUpperCase()}</strong> act.`,
    speaker: { alias: "Zipper" }
  });

  return chosen;
}

async function promptNextPcQueueDialog(candidates, { preselectedId = null, allowSkip = true } = {}) {
  const hasOptions = Array.isArray(candidates) && candidates.length > 0;
  const content = hasOptions
    ? `<p>Select who should be <strong>Up Next</strong> for the PCs.</p>
       <form class="wng-zipper-queue-form">
         ${candidates.map((c, idx) => {
           const checked = (preselectedId && c.id === preselectedId) || (!preselectedId && idx === 0);
           const img = c.img || "icons/svg/mystery-man.svg";
           return `
             <label style="display:flex;align-items:center;gap:8px;margin:6px 0;">
               <input type="radio" name="pcQueueChoice" value="${c.id}" ${checked ? "checked" : ""}>
               <img src="${img}" width="32" height="32" style="object-fit:cover;border-radius:4px;">
               <span>${c.name}</span>
             </label>
           `;
         }).join("")}
       </form>`
    : `<p>No eligible PCs remain to queue. You can leave the queue empty or cancel ending the turn.</p>`;

  return new Promise((resolve) => {
    let resolved = false;
    const buttons = {};

    if (hasOptions) {
      buttons.confirm = {
        label: "Queue PC",
        callback: (html) => {
          const selected = html[0].querySelector('input[name="pcQueueChoice"]:checked');
          const id = selected?.value ?? candidates[0]?.id ?? null;
          resolved = true;
          resolve({ cancelled: false, combatantId: id });
        }
      };
    }

    if (allowSkip) {
      buttons.skip = {
        label: "Leave Empty",
        callback: () => {
          resolved = true;
          resolve({ cancelled: false, combatantId: null });
        }
      };
    }

    buttons.cancel = {
      label: "Cancel",
      callback: () => {
        resolved = true;
        resolve({ cancelled: true });
      }
    };

    new Dialog({
      title: "Choose Next PC",
      content,
      buttons,
      default: hasOptions ? "confirm" : (allowSkip ? "skip" : "cancel"),
      close: () => {
        if (!resolved) resolve({ cancelled: true });
      }
    }).render(true);
  });
}

async function maybePromptForNextPcQueue(combat, { actingCombatant = null } = {}) {
  if (!combat) return { cancelled: false, prompted: false };
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) return { cancelled: false, prompted: false };

  const current = actingCombatant ?? combat.combatant ?? null;
  if (!current || !isPC(current)) return { cancelled: false, prompted: false };

  const allowPlayers = game.settings.get(MODULE_ID, "playersCanAdvance");
  const isOwner = current.isOwner ?? current.actor?.isOwner ?? false;
  if (!game.user.isGM && !(allowPlayers && isOwner)) return { cancelled: false, prompted: false };

  const plan = await evaluateZipperState(combat, { preview: true });
  const actedSet = new Set(plan.state.actedIds ?? []);
  if (current.id) actedSet.add(current.id);

  const queueState = plan.state.queue ?? emptyQueue();
  const candidates = plan.entries.filter((entry) => {
    if (entry.side !== "pc") return false;
    if (entry.id === current.id) return false;
    if (entry.isDefeated) return false;
    if (entry.isComplete) return false;
    if (entry.acted) return false;
    if (actedSet.has(entry.id)) return false;
    return true;
  });

  const visible = candidates.filter((entry) => {
    if (!entry.hidden) return true;
    if (game.user.isGM) return true;
    try {
      const doc = combat.combatants?.get(entry.id) ?? entry.doc ?? null;
      const actor = doc?.actor ?? null;
      return doc?.isOwner ?? actor?.isOwner ?? false;
    } catch {
      return false;
    }
  });
  const sanitized = visible.map((entry) => sanitizeEntry(entry, queueState.pc));

  const result = await promptNextPcQueueDialog(sanitized, {
    preselectedId: queueState.pc ?? null,
    allowSkip: true
  });

  if (!result || result.cancelled) {
    return { cancelled: true, prompted: true };
  }

  await updateQueuedChoice(combat, "pc", result.combatantId ?? null);
  return { cancelled: false, prompted: true };
}

/* ---------------------------------------------------------
 * Tracker dock rendering
 * --------------------------------------------------------- */
async function buildDockContext(combat) {
  const gm = game.user.isGM;
  const dockStyles = getDockStyleConfig();
  const playersFirstLabel = toSideLabel(PLAYERS_SIDE) ?? "PCs";
  const base = {
    gm,
    hasCombat: !!combat,
    enabled: false,
    playersFirstLabel,
    nextSideLabel: null,
    upcomingSideLabel: null,
    roundReset: false,
    manualPending: false,
    currentCombatant: null,
    nextCandidates: [],
    ready: cloneDisplayGroup(),
    spent: cloneDisplayGroup(),
    defeated: cloneDisplayGroup(),
    canSelectPC: false,
    canSelectNPC: false,
    allowPlayers: game.settings.get(MODULE_ID, "playersCanAdvance"),
    combatId: combat?.id ?? null,
    nextSide: null,
    dockStyles,
    selectionAction: null,
    topNextCandidate: null,
    queued: { pc: null, npc: null },
    queueControls: {
      pc: { canClear: false },
      npc: { canClear: false }
    },
    roundNumber: combat?.round ?? 0,
    turnNumber: Number.isFinite(combat?.turn) ? combat.turn + 1 : null
  };

  if (!combat) return base;

  const plan = await evaluateZipperState(combat, { preview: true });
  const queueState = plan.state.queue ?? emptyQueue();
  const effectiveNextSide = plan.display.nextSide;
  const combatStarted = !!combat.started;
  const nextSideLabel = toSideLabel(effectiveNextSide) ?? null;
  const upcomingSideLabel = toSideLabel(plan.display.upcomingSide) ?? null;
  const ready = cloneDisplayGroup(plan.display.ready);
  const spent = cloneDisplayGroup(plan.display.spent);
  const defeated = cloneDisplayGroup(plan.display.defeated);
  const rawCandidates = plan.display.nextCandidates ?? [];

  const withOwnership = (entry) => {
    if (!entry) return null;
    const doc = combat.combatants?.get(entry.id) ?? null;
    const actor = doc?.actor ?? null;
    const isOwner = entry.isOwner ?? doc?.isOwner ?? actor?.isOwner ?? false;
    return { ...entry, isOwner };
  };

  let currentCombatant = withOwnership(plan.display.current);
  const activeDoc = combat.combatant ?? null;
  const inferredSide = activeDoc ? (isPC(activeDoc) ? "pc" : "npc") : null;
  const currentSide = currentCombatant?.side ?? inferredSide ?? plan.state.currentSide ?? null;

  const annotateCandidate = (entry) => {
    const enriched = withOwnership(entry);
    if (!enriched) return null;
    const canActivate = entry?.canActivate ?? canActivateEntry(enriched, effectiveNextSide, plan.allowPlayers);
    const canQueue = plan.enabled && canQueueEntry(enriched, effectiveNextSide, currentSide, plan.allowPlayers, { combatStarted });
    return { ...enriched, canActivate, canQueue };
  };

  const nextCandidates = rawCandidates.map((entry) => annotateCandidate(entry)).filter(Boolean);
  ready.pc = ready.pc.map((entry) => annotateCandidate(entry)).filter(Boolean);
  ready.npc = ready.npc.map((entry) => annotateCandidate(entry)).filter(Boolean);

  const queued = {
    pc: withOwnership(plan.display.queue.pc),
    npc: withOwnership(plan.display.queue.npc)
  };

  const allowPlayers = plan.allowPlayers;
  const canSelectPC = plan.enabled && canActivateEntry({ side: "pc" }, effectiveNextSide, allowPlayers);
  const canSelectNPC = plan.enabled && canActivateEntry({ side: "npc" }, effectiveNextSide, allowPlayers);
  const canEndTurn = plan.enabled && !!currentCombatant && (game.user.isGM || (currentCombatant.side === "pc" && allowPlayers && currentCombatant.isOwner));
  if (currentCombatant) {
    currentCombatant = {
      ...currentCombatant,
      canEndTurn
    };
  }

  const queuePending = ["pc", "npc"].some((side) => {
    const id = queueState?.[side];
    if (!id) return false;
    if (plan.queueConsumedSide && plan.queueConsumedSide === side && effectiveNextSide === side) return false;
    return true;
  });

  const canClearQueueFor = (side) => {
    const entry = queued[side];
    if (!entry) return false;
    if (game.user.isGM) return true;
    if (side !== "pc") return false;
    if (!plan.allowPlayers) return false;
    if (!entry.isOwner) return false;
    if (currentSide && currentSide !== "npc") return false;
    return true;
  };

  const queueControls = {
    pc: { canClear: canClearQueueFor("pc") },
    npc: { canClear: canClearQueueFor("npc") }
  };

  const manualCandidate = nextCandidates.find((entry) => entry.manualSelected && entry.canActivate) ?? null;
  const preferredCandidate = manualCandidate
    ?? nextCandidates.find((entry) => entry.canActivate && (game.user.isGM || entry.isOwner))
    ?? nextCandidates.find((entry) => entry.canActivate)
    ?? null;

  const selectionAction = (() => {
    if (!plan.enabled) return null;
    if (canEndTurn && currentCombatant) {
      return {
        action: "end-turn",
        label: "End Turn",
        combatantId: currentCombatant.id,
        enabled: true
      };
    }
    if (preferredCandidate) {
      return {
        action: "activate",
        label: "Activate",
        combatantId: preferredCandidate.id,
        enabled: preferredCandidate.canActivate
      };
    }
    return null;
  })();

  const topNextCandidate = manualCandidate
    ?? nextCandidates.find((entry) => entry.manualSelected)
    ?? nextCandidates[0]
    ?? null;

  return {
    gm,
    hasCombat: true,
    enabled: plan.enabled,
    playersFirstLabel,
    nextSideLabel,
    upcomingSideLabel,
    roundReset: plan.roundReset,
    manualPending: queuePending,
    currentCombatant,
    nextCandidates,
    topNextCandidate,
    ready,
    spent,
    defeated,
    canSelectPC,
    canSelectNPC,
    allowPlayers,
    selectionAction,
    combatId: combat.id,
    nextSide: effectiveNextSide,
    dockStyles,
    queued,
    queueControls,
    roundNumber: combat.round ?? 0,
    turnNumber: Number.isFinite(combat.turn) ? combat.turn + 1 : null
  };
}

function bindDockListeners(wrapper) {
  wrapper.off("click.wng-zipper");
  wrapper.on("click.wng-zipper", "[data-action]", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    const action = target.dataset.action;
    const combat = game.combat;
    if (!combat) {
      ui.notifications.warn("No active combat to control.");
      return;
    }

    try {
      switch (action) {
        case "toggle-module":
          await handleToggleZipper(combat);
          break;
        case "activate":
          await handleManualActivation(combat, target.dataset.combatantId);
          break;
        case "queue":
          await handleQueueRequest(combat, target.dataset.combatantId, target.dataset.side);
          break;
        case "queue-clear":
          await handleQueueClear(combat, target.dataset.side);
          break;
        case "end-turn":
          await handleEndTurn(combat, target.dataset.combatantId);
          break;
        default:
          break;
      }
    } catch (err) {
      log(err);
      ui.notifications.error("Zipper dock action failed. See console for details.");
    }
  });
}

function getViewportBounds() {
  const doc = document.documentElement;
  return {
    width: window.innerWidth || doc?.clientWidth || 1920,
    height: window.innerHeight || doc?.clientHeight || 1080
  };
}

async function persistDockPosition(rect) {
  const viewport = getViewportBounds();
  const width = clamp(Math.round(rect.width), DOCK_SIZE_LIMITS.width.min, DOCK_SIZE_LIMITS.width.max);
  const topOffset = clamp(Math.round(rect.top), 0, 2000);
  const anchor = rect.left + rect.width / 2 >= viewport.width / 2 ? "right" : "left";
  const sideOffset = anchor === "left"
    ? clamp(Math.round(rect.left), 0, 2000)
    : clamp(Math.round(viewport.width - (rect.left + rect.width)), 0, 2000);

  if (!canPersistDockSettings()) {
    updateDockOverrides({ anchor, top: topOffset, side: sideOffset, width });
    requestDockRender();
    return;
  }

  let saved = false;
  try {
    await Promise.all([
      game.settings.set(MODULE_ID, "dockAnchor", anchor),
      game.settings.set(MODULE_ID, "dockTopOffset", topOffset),
      game.settings.set(MODULE_ID, "dockSideOffset", sideOffset),
      game.settings.set(MODULE_ID, "dockWidth", width)
    ]);
    saved = true;
  } catch (err) {
    log(err);
  }

  if (saved) {
    clearDockOverrides(["anchor", "top", "side", "width"]);
  } else {
    updateDockOverrides({ anchor, top: topOffset, side: sideOffset, width });
  }

  requestDockRender();
}

async function persistDockSize(rect) {
  const viewport = getViewportBounds();
  const maxHeight = Math.min(DOCK_SIZE_LIMITS.height.max, Math.max(DOCK_SIZE_LIMITS.height.min, viewport.height - Math.max(0, rect.top)));
  const width = clamp(Math.round(rect.width), DOCK_SIZE_LIMITS.width.min, DOCK_SIZE_LIMITS.width.max);
  const height = clamp(Math.round(rect.height), DOCK_SIZE_LIMITS.height.min, maxHeight);

  if (!canPersistDockSettings()) {
    updateDockOverrides({ width, height });
    requestDockRender();
    return;
  }

  let saved = false;
  try {
    await Promise.all([
      game.settings.set(MODULE_ID, "dockWidth", width),
      game.settings.set(MODULE_ID, "dockHeight", height)
    ]);
    saved = true;
  } catch (err) {
    log(err);
  }

  if (saved) {
    clearDockOverrides(["width", "height"]);
  } else {
    updateDockOverrides({ width, height });
  }

  requestDockRender();
}

function setupDockDrag(root) {
  const element = root.get(0);
  if (!element) return;

  const handle = root.find(".wng-zipper-tracker .tracker-header").get(0);
  if (!handle) return;

  let pointerId = null;
  let startRect = null;
  let startPoint = null;

  const onPointerMove = (event) => {
    if (pointerId === null || event.pointerId !== pointerId || !startRect || !startPoint) return;
    event.preventDefault();

    const viewport = getViewportBounds();
    const dx = event.clientX - startPoint.x;
    const dy = event.clientY - startPoint.y;
    const nextWidth = startRect.width;
    const nextHeight = startRect.height;
    const maxTop = Math.max(0, viewport.height - nextHeight);
    const maxLeft = Math.max(0, viewport.width - nextWidth);
    const nextTop = clamp(startRect.top + dy, 0, maxTop);
    const nextLeft = clamp(startRect.left + dx, 0, maxLeft);

    element.style.top = `${Math.round(nextTop)}px`;
    element.style.left = `${Math.round(nextLeft)}px`;
    element.style.right = "auto";
  };

  const release = async (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;

    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    element.classList.remove("is-dragging");

    pointerId = null;
    startRect = null;
    startPoint = null;

    const rect = element.getBoundingClientRect();
    await persistDockPosition(rect);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.("button, [data-action], input, select, textarea, a")) return;

    startRect = element.getBoundingClientRect();
    startPoint = { x: event.clientX, y: event.clientY };
    pointerId = event.pointerId;
    element.classList.add("is-dragging");
    element.style.right = "auto";

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", release, { passive: false });
    window.addEventListener("pointercancel", release, { passive: false });

    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
}

function setupDockResize(root) {
  const element = root.get(0);
  if (!element) return;

  const handle = root.find("[data-dock-resize]").get(0);
  if (!handle) return;

  let pointerId = null;
  let startRect = null;
  let startPoint = null;

  const onPointerMove = (event) => {
    if (pointerId === null || event.pointerId !== pointerId || !startRect || !startPoint) return;
    event.preventDefault();

    const viewport = getViewportBounds();
    const dx = event.clientX - startPoint.x;
    const dy = event.clientY - startPoint.y;
    const maxWidth = Math.min(DOCK_SIZE_LIMITS.width.max, Math.max(DOCK_SIZE_LIMITS.width.min, viewport.width - Math.max(0, startRect.left)));
    const maxHeight = Math.min(DOCK_SIZE_LIMITS.height.max, Math.max(DOCK_SIZE_LIMITS.height.min, viewport.height - Math.max(0, startRect.top)));
    const width = clamp(startRect.width + dx, DOCK_SIZE_LIMITS.width.min, maxWidth);
    const height = clamp(startRect.height + dy, DOCK_SIZE_LIMITS.height.min, maxHeight);

    element.style.width = `${Math.round(width)}px`;
    element.style.height = `${Math.round(height)}px`;
  };

  const release = async (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;

    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    element.classList.remove("is-resizing");

    const capturedId = pointerId;
    pointerId = null;
    startRect = null;
    startPoint = null;

    if (typeof handle.releasePointerCapture === "function" && capturedId !== null) {
      try { handle.releasePointerCapture(capturedId); } catch (err) { /* ignore capture failures */ }
    }

    const rect = element.getBoundingClientRect();
    await persistDockSize(rect);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;

    startRect = element.getBoundingClientRect();
    startPoint = { x: event.clientX, y: event.clientY };
    pointerId = event.pointerId;
    element.classList.add("is-resizing");
    element.style.right = "auto";
    if (typeof handle.setPointerCapture === "function") {
      try { handle.setPointerCapture(pointerId); } catch (err) { /* ignore capture failures */ }
    }

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", release, { passive: false });
    window.addEventListener("pointercancel", release, { passive: false });

    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });

  handle.addEventListener("dblclick", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!canPersistDockSettings()) {
      updateDockOverrides({ height: 0 });
      requestDockRender();
      return;
    }

    let saved = false;
    try {
      await game.settings.set(MODULE_ID, "dockHeight", 0);
      saved = true;
    } catch (err) {
      log(err);
    }

    if (saved) {
      clearDockOverrides(["height"]);
    } else {
      updateDockOverrides({ height: 0 });
    }

    requestDockRender();
  });
}

function enableDockInteractivity(root) {
  setupDockDrag(root);
  setupDockResize(root);
}

function ensureDockRoot() {
  let root = document.getElementById(DOCK_ROOT_ID);
  if (!root) {
    root = document.createElement("section");
    root.id = DOCK_ROOT_ID;
    root.classList.add("wng-zipper-dock-root");
    document.body.appendChild(root);
  }
  return $(root);
}

async function renderStandaloneDock() {
  const root = ensureDockRoot();
  const combat = game.combat ?? null;
  const context = await buildDockContext(combat);
  const modulePath = game.modules.get(MODULE_ID)?.path ?? `modules/${MODULE_ID}`;
  const templatePath = `${modulePath}/${DOCK_TEMPLATE}`.replace(/\/+/g, "/");
  const rendered = await foundry.applications.handlebars.renderTemplate(templatePath, context);
  root.html(`<div class="${DOCK_WRAPPER_CLASS}">${rendered}</div>`);
  bindDockListeners(root);
  enableDockInteractivity(root);
  root.toggleClass("is-active", !!context.enabled);
  root.toggleClass("has-combat", !!context.hasCombat);
  root.toggleClass("is-hidden", !context.hasCombat);
}

let dockRenderPending = false;
function requestDockRender() {
  if (!game?.ready) return;
  if (dockRenderPending) return;
  dockRenderPending = true;
  setTimeout(async () => {
    dockRenderPending = false;
    try {
      await renderStandaloneDock();
    } catch (err) {
      log(err);
    }
  }, 0);
}

async function handleToggleZipper(combat) {
  const enabled = !!(await combat.getFlag(MODULE_ID, "enabled"));
  const next = !enabled;
  await combat.setFlag(MODULE_ID, "enabled", next);
  if (next) {
    await ensurePlayersLead(combat, { resetActed: true, resetCurrentSide: true });
  }
  ui.combat.render(true);
  requestDockRender();
}

async function handleManualActivation(combat, combatantId) {
  if (!combatantId) return;
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) {
    ui.notifications.warn("Zipper initiative is disabled for this combat.");
    return;
  }

  const plan = await evaluateZipperState(combat, { preview: true });
  const entry = plan.entries.find((e) => e.id === combatantId);
  if (!entry || entry.isDefeated) {
    ui.notifications.warn("That combatant cannot act right now.");
    return;
  }

  const side = entry.side;
  const allowPlayers = plan.allowPlayers;
  const doc = combat.combatants?.get(entry.id) ?? entry.doc ?? null;
  const actor = doc?.actor ?? null;
  const isOwner = doc?.isOwner ?? actor?.isOwner ?? false;
  const queueState = plan.state.queue ?? emptyQueue();
  const sanitized = sanitizeEntry(entry, queueState[side]);
  const currentDoc = combat.combatant ?? null;
  const currentSide = currentDoc ? (isPC(currentDoc) ? "pc" : "npc") : null;
  const currentId = currentDoc?.id ?? null;
  const effectiveNextSide = plan.display.nextSide;
  const combatStarted = !!combat.started;
  const canActivateNow = canActivateEntry(sanitized, effectiveNextSide, allowPlayers);
  const canQueueNow = canQueueEntry({ ...sanitized, isOwner }, effectiveNextSide, currentSide, allowPlayers, { combatStarted });

  let mode = null;
  if (currentSide && currentSide !== side && !game.user.isGM) {
    if (canQueueNow) mode = "queue";
  } else if (canActivateNow) {
    mode = "activate";
  } else if (canQueueNow) {
    mode = "queue";
  } else if (game.user.isGM) {
    mode = currentSide && currentSide !== side ? "queue" : "activate";
  }

  if (!mode) {
    ui.notifications.warn("That combatant cannot act right now.");
    return;
  }

  if (!game.user.isGM) {
    if (side !== "pc") {
      ui.notifications.warn("You cannot control that combatant.");
      return;
    }
    if (!allowPlayers) {
      ui.notifications.warn("Only the GM may choose that combatant.");
      return;
    }
    if (!isOwner) {
      ui.notifications.warn("You do not control that combatant.");
      return;
    }
    if (mode === "activate") {
      if (currentSide && currentSide !== side) {
        ui.notifications.warn("Wait for the current activation to finish.");
        return;
      }
      if (currentId && currentId !== combatantId) {
        ui.notifications.warn("Another combatant is already acting.");
        return;
      }
    }
  }

  if (mode === "queue") {
    await updateQueuedChoice(combat, side, combatantId);
    ui.combat.render(true);
    requestDockRender();
    return;
  }

  await updateQueuedChoice(combat, side, combatantId);
  await combat.nextTurn();
  ui.combat.render(true);
  requestDockRender();
}

async function handleQueueRequest(combat, combatantId, sideHint) {
  if (!combatantId) return;
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) {
    ui.notifications.warn("Zipper initiative is disabled for this combat.");
    return;
  }

  const plan = await evaluateZipperState(combat, { preview: true });
  const entry = plan.entries.find((e) => e.id === combatantId);
  if (!entry || entry.isDefeated) {
    ui.notifications.warn("That combatant cannot be queued right now.");
    return;
  }

  const side = entry.side;
  if (sideHint && sideHint !== side) return;

  const allowPlayers = plan.allowPlayers;
  const doc = combat.combatants?.get(entry.id) ?? entry.doc ?? null;
  const actor = doc?.actor ?? null;
  const isOwner = doc?.isOwner ?? actor?.isOwner ?? false;
  const queueState = plan.state.queue ?? emptyQueue();
  const sanitized = sanitizeEntry(entry, queueState[side]);
  const currentDoc = combat.combatant ?? null;
  const currentSide = currentDoc ? (isPC(currentDoc) ? "pc" : "npc") : plan.state.currentSide ?? null;
  const effectiveNextSide = plan.display.nextSide;

  const combatStarted = !!combat.started;
  if (!canQueueEntry({ ...sanitized, isOwner }, effectiveNextSide, currentSide, allowPlayers, { combatStarted })) {
    ui.notifications.warn("That combatant cannot be queued right now.");
    return;
  }

  if (!game.user.isGM) {
    if (side !== "pc") {
      ui.notifications.warn("You cannot queue that combatant.");
      return;
    }
    if (!allowPlayers) {
      ui.notifications.warn("Only the GM may adjust the PC queue.");
      return;
    }
    if (!isOwner) {
      ui.notifications.warn("You do not control that combatant.");
      return;
    }
  }

  await updateQueuedChoice(combat, side, combatantId);
  ui.combat.render(true);
  requestDockRender();
}

async function handleQueueClear(combat, side) {
  if (!side || !["pc", "npc"].includes(side)) return;
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) return;

  const plan = await evaluateZipperState(combat, { preview: true });
  const queueState = plan.state.queue ?? emptyQueue();
  const queuedId = queueState[side];
  if (!queuedId) return;

  const entry = plan.entries.find((e) => e.id === queuedId) ?? null;
  const sanitized = entry ? sanitizeEntry(entry, queuedId) : null;
  const isOwner = sanitized?.isOwner ?? entry?.doc?.isOwner ?? entry?.doc?.actor?.isOwner ?? false;
  const currentDoc = combat.combatant ?? null;
  const currentSide = currentDoc ? (isPC(currentDoc) ? "pc" : "npc") : plan.state.currentSide ?? null;

  if (!game.user.isGM) {
    if (side !== "pc") {
      ui.notifications.warn("You cannot clear that queue.");
      return;
    }
    if (!plan.allowPlayers) {
      ui.notifications.warn("Only the GM may clear the PC queue.");
      return;
    }
    if (!isOwner) {
      ui.notifications.warn("You do not control that combatant.");
      return;
    }
    if (currentSide && currentSide !== "npc") {
      ui.notifications.warn("You can only adjust the PC queue while NPCs are acting.");
      return;
    }
  }

  await updateQueuedChoice(combat, side, null);
  ui.combat.render(true);
  requestDockRender();
}

async function handleEndTurn(combat, combatantId) {
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) {
    await combat.nextTurn();
    ui.combat.render(true);
    requestDockRender();
    return;
  }

  const current = combat.combatant;
  if (!current) {
    ui.notifications.warn("There is no active combatant to end.");
    return;
  }

  if (combatantId && current.id !== combatantId && !game.user.isGM) {
    ui.notifications.warn("You cannot control that combatant.");
    return;
  }

  const allowPlayers = game.settings.get(MODULE_ID, "playersCanAdvance");
  const currentIsPC = isPC(current);
  const currentIsOwner = current.isOwner ?? current.actor?.isOwner ?? false;

  if (!game.user.isGM && !(allowPlayers && currentIsPC && currentIsOwner)) {
    ui.notifications.warn("You cannot end this activation.");
    return;
  }

  let bypassQueuePrompt = false;
  if (currentIsPC) {
    const outcome = await maybePromptForNextPcQueue(combat, { actingCombatant: current });
    if (outcome.cancelled) return;
    bypassQueuePrompt = true;
    queuePromptBypass.add(combat.id);
  }

  try {
    await combat.nextTurn();
  } finally {
    if (bypassQueuePrompt) queuePromptBypass.delete(combat.id);
  }
  ui.combat.render(true);
  requestDockRender();
}

Hooks.on("renderCombatTracker", async (app, html) => {
  requestDockRender();
});

Hooks.once("ready", () => {
  registerSocketBridge();
});

Hooks.once("ready", () => {
  requestDockRender();
});

const dockRefreshHooks = [
  "createCombat", "deleteCombat", "updateCombat", "combatTurn",
  "createCombatant", "updateCombatant", "deleteCombatant"
];

for (const hook of dockRefreshHooks) {
  Hooks.on(hook, () => requestDockRender());
}

/* ---------------------------------------------------------
 * Public API
 * --------------------------------------------------------- */
Hooks.once("ready", () => {
  const api = {
    async enableForActiveCombat(on = true) {
      const c = game.combat; if (!c) return false;
      const next = !!on;
      await c.setFlag(MODULE_ID, "enabled", next);
      if (next) await ensurePlayersLead(c, { resetActed: true, resetCurrentSide: true });
      ui.combat.render(); return true;
    },
    async setPriority(side = "pc") {
      const c = game.combat; if (!c) return false;
      if (side !== PLAYERS_SIDE) {
        ui.notifications?.warn?.("Zipper priority is fixed to PCs and cannot be reassigned.");
      }
      await ensurePlayersLead(c, { resetActed: true, resetCurrentSide: true });
      ui.combat.render(); return true;
    },
    async advanceTo(combatantId) {
      const c = game.combat; if (!c) return false;
      if (!combatantId) return false;
      if (!(await c.getFlag(MODULE_ID, "enabled"))) return false;
      await c.setFlag(MODULE_ID, MANUAL_CHOICE_FLAG, combatantId);
      await c.nextTurn();
      return true;
    },
    async getState(opts = {}) {
      const c = game.combat; if (!c) return null;
      return evaluateZipperState(c, { preview: true, ...(opts || {}) });
    }
  };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
});

/*******************************************************************************************
 * Macro Example
 * ---------------------------------------------------------
 * Example macro players/GMs can drop into their hotbar to toggle the zipper
 * initiative mode for the active combat. Uncomment to use in Foundry.
 *
 * (async () => {
 *   const mod = game.modules.get(MODULE_ID);
 *   if (!mod?.active) return ui.notifications.error("wng-zipper not active.");
 *   const c = game.combat; if (!c) return ui.notifications.warn("No active combat.");
 *   const on = !(await c.getFlag(MODULE_ID, "enabled"));
 *   await mod.api.enableForActiveCombat(on);
 *   ui.notifications.info(`Zipper ${on ? "ENABLED" : "disabled"}.`);
 * })();
 */
