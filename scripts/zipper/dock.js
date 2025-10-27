import {
  DOCK_DEFAULTS,
  DOCK_ROOT_ID,
  DOCK_SIZE_LIMITS,
  DOCK_TEMPLATE,
  DOCK_WRAPPER_CLASS,
  MODULE_ID,
  PLAYERS_SIDE
} from "./constants.js";
import {
  ensurePlayersLead,
  evaluateZipperState,
  activateCombatant,
  advanceCombatTurn,
  queuePromptBypass,
  emptyQueue,
  cloneDisplayGroup,
  updateQueuedChoice,
  clearQueuedChoice,
  maybePromptForNextPcQueue
} from "./combat.js";
import {
  canActivateEntry,
  canQueueEntry,
  computeEntryPermissions,
  isPC,
  sanitizeEntry,
  toSideLabel
} from "./permissions.js";
import {
  canPersistDockSettings,
  clearDockOverrides,
  getDockOverrides,
  updateDockOverrides
} from "./dock-overrides.js";
import { log, reportDockActionFailure, clamp } from "./utils.js";

export function getDockStyleConfig() {
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

export async function buildDockContext(combat) {
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

  const withPermissions = (entry) => {
    if (!entry) return null;
    const doc = combat.combatants?.get(entry.id) ?? null;
    const actor = doc?.actor ?? null;
    const { isOwner, canControl } = computeEntryPermissions(doc, actor, entry);
    return { ...entry, isOwner, canControl };
  };

  let currentCombatant = withPermissions(plan.display.current);
  const activeDoc = combat.combatant ?? null;
  const inferredSide = activeDoc ? (isPC(activeDoc) ? "pc" : "npc") : null;
  const activeSide = currentCombatant?.side ?? inferredSide ?? null;
  const currentSide = activeSide ?? plan.state.currentSide ?? null;

  const annotateCandidate = (entry) => {
    const enriched = withPermissions(entry);
    if (!enriched) return null;
    const canActivate = entry?.canActivate ?? canActivateEntry(enriched, effectiveNextSide, plan.allowPlayers);
    const canQueue = plan.enabled && canQueueEntry(enriched, effectiveNextSide, activeSide, plan.allowPlayers, { combatStarted });
    return { ...enriched, canActivate, canQueue };
  };

  const nextCandidates = rawCandidates.map((entry) => annotateCandidate(entry)).filter(Boolean);
  ready.pc = ready.pc.map((entry) => annotateCandidate(entry)).filter(Boolean);
  ready.npc = ready.npc.map((entry) => annotateCandidate(entry)).filter(Boolean);

  const queued = {
    pc: withPermissions(plan.display.queue.pc),
    npc: withPermissions(plan.display.queue.npc)
  };

  const allowPlayers = plan.allowPlayers;
  const canSelectPC = plan.enabled && canActivateEntry({ side: "pc" }, effectiveNextSide, allowPlayers);
  const canSelectNPC = plan.enabled && canActivateEntry({ side: "npc" }, effectiveNextSide, allowPlayers);
  const canEndTurn = plan.enabled && !!currentCombatant && (game.user.isGM || (currentCombatant.side === "pc" && allowPlayers && currentCombatant.canControl));
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
    if (!entry.canControl) return false;
    if (activeSide && activeSide !== "npc") return false;
    return true;
  };

  const queueControls = {
    pc: { canClear: canClearQueueFor("pc") },
    npc: { canClear: canClearQueueFor("npc") }
  };

  const manualCandidate = nextCandidates.find((entry) => entry.manualSelected && entry.canActivate) ?? null;
  const preferredCandidate = manualCandidate
    ?? nextCandidates.find((entry) => entry.canActivate && (game.user.isGM || entry.canControl))
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

export function describeDockAction(action) {
  switch (action) {
    case "toggle-module":
      return "module toggle";
    case "activate":
      return "activation request";
    case "queue":
      return "queue update";
    case "queue-clear":
      return "queue clear";
    case "end-turn":
      return "end turn request";
    case "reset-round":
      return "round reset";
    case "advance-round":
      return "round advance";
    default:
      return "dock action";
  }
}

export function bindDockListeners(wrapper) {
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
        case "reset-round":
          await handleResetRound(combat);
          break;
        case "advance-round":
          await handleAdvanceRound(combat);
          break;
        default:
          break;
      }
    } catch (err) {
      reportDockActionFailure(err, { action: describeDockAction(action) });
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

export async function renderStandaloneDock() {
  const root = ensureDockRoot();
  const combat = game.combat ?? null;
  const context = await buildDockContext(combat);
  const modulePath = game.modules.get(MODULE_ID)?.path ?? `modules/${MODULE_ID}`;
  const templatePath = `${modulePath}/${DOCK_TEMPLATE}`.replace(/\\+/g, "/");
  const rendered = await foundry.applications.handlebars.renderTemplate(templatePath, context);
  root.html(`<div class="${DOCK_WRAPPER_CLASS}">${rendered}</div>`);
  bindDockListeners(root);
  enableDockInteractivity(root);
  root.toggleClass("is-active", !!context.enabled);
  root.toggleClass("has-combat", !!context.hasCombat);
  root.toggleClass("is-hidden", !context.hasCombat);
}

let dockRenderPending = false;
export function requestDockRender() {
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

export async function handleToggleZipper(combat) {
  const enabled = !!(await combat.getFlag(MODULE_ID, "enabled"));
  const next = !enabled;
  await combat.setFlag(MODULE_ID, "enabled", next);
  if (next) {
    await ensurePlayersLead(combat, { resetActed: true, resetCurrentSide: true });
  }
  ui.combat.render(true);
  requestDockRender();
}

export async function handleManualActivation(combat, combatantId) {
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
  const queueState = plan.state.queue ?? emptyQueue();
  const sanitized = sanitizeEntry(entry, queueState[side]);
  const currentDoc = combat.combatant ?? null;
  const currentSide = currentDoc ? (isPC(currentDoc) ? "pc" : "npc") : null;
  const currentId = currentDoc?.id ?? null;
  const effectiveNextSide = plan.display.nextSide;
  const combatStarted = !!combat.started;
  const canActivateNow = canActivateEntry(sanitized, effectiveNextSide, allowPlayers);
  const canQueueNow = canQueueEntry(sanitized, effectiveNextSide, currentSide, allowPlayers, { combatStarted });

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
    if (!sanitized.canControl) {
      ui.notifications.warn("You do not control that combatant.");
      return;
    }
    if (mode === "queue" && !allowPlayers) {
      ui.notifications.warn("Only the GM may choose that combatant.");
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

  if (!currentId) {
    await activateCombatant(combat, combatantId, { side });
  } else {
    await updateQueuedChoice(combat, side, combatantId);
    await advanceCombatTurn(combat, { bypassQueuePrompt: true });
  }
  ui.combat.render(true);
  requestDockRender();
}

export async function handleQueueRequest(combat, combatantId, sideHint) {
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
  const queueState = plan.state.queue ?? emptyQueue();
  const sanitized = sanitizeEntry(entry, queueState[side]);
  const currentDoc = combat.combatant ?? null;
  const currentSide = currentDoc ? (isPC(currentDoc) ? "pc" : "npc") : null;
  const effectiveNextSide = plan.display.nextSide;

  const combatStarted = !!combat.started;
  if (!canQueueEntry(sanitized, effectiveNextSide, currentSide, allowPlayers, { combatStarted })) {
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
    if (!sanitized.canControl) {
      ui.notifications.warn("You do not control that combatant.");
      return;
    }
  }

  await updateQueuedChoice(combat, side, combatantId);
  ui.combat.render(true);
  requestDockRender();
}

export async function handleQueueClear(combat, side) {
  if (!side || !["pc", "npc"].includes(side)) return;
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) return;

  const plan = await evaluateZipperState(combat, { preview: true });
  const queueState = plan.state.queue ?? emptyQueue();
  const queuedId = queueState[side];
  if (!queuedId) return;

  const entry = plan.entries.find((e) => e.id === queuedId) ?? null;
  const sanitized = entry ? sanitizeEntry(entry, queuedId) : null;
  const currentDoc = combat.combatant ?? null;
  const currentSide = currentDoc ? (isPC(currentDoc) ? "pc" : "npc") : null;

  if (!game.user.isGM) {
    if (side !== "pc") {
      ui.notifications.warn("You cannot clear that queue.");
      return;
    }
    if (!plan.allowPlayers) {
      ui.notifications.warn("Only the GM may clear the PC queue.");
      return;
    }
    if (!sanitized?.canControl) {
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

export async function handleAdvanceRound(combat) {
  if (!combat) return;
  if (!game.user?.isGM) {
    ui.notifications.warn("Only the GM may advance the round.");
    return;
  }

  await combat.nextRound();
  ui.combat.render(true);
  requestDockRender();
}

export async function handleResetRound(combat) {
  if (!combat) return;
  if (!game.user?.isGM) {
    ui.notifications.warn("Only the GM may reset the round.");
    return;
  }

  const enabled = await combat.getFlag(MODULE_ID, "enabled");

  if (enabled) {
    await combat.setFlag(MODULE_ID, "actedIds", []);
    await ensurePlayersLead(combat, { resetCurrentSide: true });
    await clearQueuedChoice(combat);
    queuePromptBypass.delete(combat.id);
  }

  let pendingData = [];
  try {
    pendingData = combat.combatants?.map?.((c) => (typeof c?.setPending === "function" ? c.setPending() : null))
      ?.filter(Boolean) ?? [];
  } catch (err) {
    log(err);
  }

  const updateData = { turn: null };
  if (pendingData.length) updateData.combatants = pendingData;

  try {
    await combat.update(updateData);
  } catch (err) {
    log(err);
  }

  if (enabled) {
    const firstLabel = toSideLabel(PLAYERS_SIDE) ?? "PCs";
    try {
      await ChatMessage.create({
        content: `<strong>Zipper:</strong> Round reset. <em>${firstLabel}</em> choose the next activation.`,
        whisper: ChatMessage.getWhisperRecipients("GM")
      });
    } catch (err) {
      log(err);
    }
  }

  ui.combat.render(true);
  requestDockRender();
}

export async function handleEndTurn(combat, combatantId) {
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) {
    await advanceCombatTurn(combat);
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
  const { canControl: currentCanControl } = computeEntryPermissions(current, current.actor, current);

  if (!game.user.isGM && !(allowPlayers && currentIsPC && currentCanControl)) {
    ui.notifications.warn("You cannot end this activation.");
    return;
  }

  let bypassQueuePrompt = false;
  if (currentIsPC) {
    const outcome = await maybePromptForNextPcQueue(combat, { actingCombatant: current });
    if (outcome.cancelled) return;
    bypassQueuePrompt = true;
  }

  await advanceCombatTurn(combat, { bypassQueuePrompt });
  ui.combat.render(true);
  requestDockRender();
}
