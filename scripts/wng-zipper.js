/*******************************************************************************************
 * Wrath & Glory — Zipper Initiative for Foundry VTT
 * Author: Ariel Cember + GPT-5
 * Version: 0.3.0
 * 
 * Implements strict alternate-activation (PC↔NPC) initiative with a Priority side each round.
 * When multiple PCs are eligible, players choose who acts next.
 * GM always retains override authority. Falls back to default Foundry initiative if disabled.
 *******************************************************************************************/

const MODULE_ID = "wng-zipper-initiative";
const MANUAL_CHOICE_FLAG = "manualChoice";
const DOCK_TEMPLATE = `modules/${MODULE_ID}/templates/zipper-tracker.hbs`;
const DOCK_WRAPPER_CLASS = "wng-zipper-tracker-container";
const DOCK_ROOT_ID = "wng-zipper-dock";
const DOCK_DEFAULTS = {
  anchor: "right",
  topOffset: 120,
  sideOffset: 16,
  width: 320,
  maxHeightBuffer: 160,
  inactiveOpacity: 0.7,
  noCombatOpacity: 0.85,
  backgroundOpacity: 0.35
};

/* ---------------------------------------------------------
 * Utility helpers
 * --------------------------------------------------------- */
const log = (...args) => console.log(`[%c${MODULE_ID}%c]`, "color:#2ea043", "color:inherit", ...args);
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

const sanitizeEntry = (entry, manualId) => {
  const statusLabel = formatStatusLabel(entry.status, entry);
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
    manualSelected: !!manualId && entry.id === manualId
  };
};

const canActivateEntry = (entry, nextSide, allowPlayers) => {
  if (!entry) return false;
  if (nextSide && entry.side !== nextSide) return false;
  if (entry.side === "npc") return game.user.isGM;
  return game.user.isGM || allowPlayers;
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
  const anchor = anchorSetting === "left" ? "left" : "right";
  const top = readNumericSetting("dockTopOffset", DOCK_DEFAULTS.topOffset, { min: 0, max: 2000 });
  const side = readNumericSetting("dockSideOffset", DOCK_DEFAULTS.sideOffset, { min: 0, max: 2000 });
  const width = readNumericSetting("dockWidth", DOCK_DEFAULTS.width, { min: 200, max: 1200 });
  const buffer = readNumericSetting("dockMaxHeightBuffer", DOCK_DEFAULTS.maxHeightBuffer, { min: 0, max: 2000 });
  const inactiveOpacity = readOpacitySetting("dockInactiveOpacity", DOCK_DEFAULTS.inactiveOpacity);
  const noCombatOpacity = readOpacitySetting("dockNoCombatOpacity", DOCK_DEFAULTS.noCombatOpacity);
  const backgroundOpacity = readOpacitySetting("dockBackgroundOpacity", DOCK_DEFAULTS.backgroundOpacity);

  return {
    anchor,
    top: `${top}px`,
    side: `${side}px`,
    width: `${width}px`,
    maxHeight: `calc(100vh - ${buffer}px)`,
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

async function evaluateZipperState(combat, opts = {}) {
  const preview = !!opts.preview;
  const forceStart = !!opts.forceStartOfRound;
  const enabled = await combat.getFlag(MODULE_ID, "enabled");
  const startingSide = await combat.getFlag(MODULE_ID, "startingSide") ?? "pc";
  const currentSideFlag = forceStart ? null : await combat.getFlag(MODULE_ID, "currentSide");
  const manualFlag = await combat.getFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  const plan = {
    preview,
    enabled,
    rawManualChoiceId: manualFlag,
    state: {
      startingSide,
      currentSide: currentSideFlag,
      actedIds: [],
      manualChoiceId: manualFlag,
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
      manualChoiceId: manualFlag
    },
    choice: null,
    manualUsed: false,
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

  const visibleEntries = entries.filter(e => !e.hidden || game.user.isGM);
  const available = (side, set = acted) => entries.filter((e) => {
    if (e.side !== side) return false;
    if (e.isDefeated) return false;
    if (set.has(e.id)) return false;
    if (e.hidden && !game.user.isGM) return false;
    return true;
  });
  const freshPool = (side) => entries.filter((e) => {
    if (e.side !== side) return false;
    if (e.isDefeated) return false;
    if (e.hidden && !game.user.isGM) return false;
    return true;
  });

  const pcAvail = available("pc", acted);
  const npcAvail = available("npc", acted);

  let nextSide = plan.state.currentSide || plan.state.startingSide;
  let options = [];
  let choice = null;
  let manualEntry = entries.find(e => e.id === plan.state.manualChoiceId && !e.isDefeated && !acted.has(e.id));

  if (!pcAvail.length && !npcAvail.length) {
    plan.roundReset = true;
    plan.clearActed = true;
    nextSide = plan.state.startingSide;
    options = freshPool(plan.state.startingSide);
    choice = options[0] ?? null;
    if (choice) {
      plan.roundResetMessage = `<strong>Zipper:</strong> All combatants acted. New round begins with <em>${nextSide.toUpperCase()}</em>.`;
    }
    plan.display.upcomingSide = nextSide;
  } else {
    if (nextSide === "pc" && !pcAvail.length) nextSide = "npc";
    if (nextSide === "npc" && !npcAvail.length) nextSide = "pc";

    options = nextSide === "pc" ? pcAvail : npcAvail;
    if (options.length) {
      if (manualEntry && manualEntry.side === nextSide && options.some(o => o.id === manualEntry.id)) {
        choice = manualEntry;
        plan.manualUsed = true;
      } else {
        manualEntry = null;
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
  plan.state.manualChoiceId = manualEntry ? manualEntry.id : null;
  plan.display.manualChoiceId = plan.state.manualChoiceId;
  const effectiveNextSide = options.length ? nextSide : null;
  plan.display.nextSide = effectiveNextSide;
  plan.display.nextCandidates = options
    .filter(e => !e.hidden || game.user.isGM)
    .map((e) => {
      const sanitized = sanitizeEntry(e, plan.state.manualChoiceId);
      sanitized.canActivate = canActivateEntry(sanitized, effectiveNextSide, plan.allowPlayers);
      return sanitized;
    });
  const currentVisible = visibleEntries.find(e => e.isCurrent) ?? null;
  plan.display.current = currentVisible ? sanitizeEntry(currentVisible, plan.state.manualChoiceId) : null;

  for (const entry of visibleEntries) {
    const sanitized = sanitizeEntry(entry, plan.state.manualChoiceId);
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
      await combat.setFlag(MODULE_ID, "enabled", !now);
      if (!now && !(await combat.getFlag(MODULE_ID, "startingSide"))) {
        await chooseStartingSide(combat);
      }
      app.render();
    }
  });

  if (combat?.getFlag(MODULE_ID, "enabled")) {
    buttons.unshift({
      label: `Priority: ${combat.getFlag(MODULE_ID, "startingSide")?.toUpperCase() || "?"}`,
      class: "zipper-priority",
      icon: "fas fa-trophy",
      onclick: () => chooseStartingSide(combat)
    });
  }
});

/* ---------------------------------------------------------
 * Priority chooser
 * --------------------------------------------------------- */
async function chooseStartingSide(combat) {
  const fallback = (await combat.getFlag(MODULE_ID, "startingSide")) ?? "pc";
  return new Promise((resolve) => {
    let done = false;
    const finalize = async (side) => {
      if (done) return;
      done = true;
      const chosen = side ?? fallback ?? "pc";
      await combat.setFlag(MODULE_ID, "startingSide", chosen);
      await combat.setFlag(MODULE_ID, "currentSide", chosen);
      await combat.setFlag(MODULE_ID, "actedIds", []);
      resolve(chosen);
    };

    new Dialog({
      title: "Choose Priority (Starting Side)",
      content: `<p>Which side has Priority this combat? (Wrath & Glory Core Rules)</p>`,
      buttons: {
        pc: {
          label: "PCs First",
          callback: () => finalize("pc")
        },
        npc: {
          label: "NPCs First",
          callback: () => finalize("npc")
        }
      },
      default: fallback === "npc" ? "npc" : "pc",
      close: () => finalize()
    }).render(true);
  });
}

/* ---------------------------------------------------------
 * Initialize per-combat defaults
 * --------------------------------------------------------- */
Hooks.on("createCombat", async (combat) => {
  try {
    const auto = game.settings.get(MODULE_ID, "enabledByDefault");
    await combat.setFlag(MODULE_ID, "enabled", !!auto);
    await combat.setFlag(MODULE_ID, "actedIds", []);
    await combat.setFlag(MODULE_ID, "currentSide", null);
    await combat.setFlag(MODULE_ID, "startingSide", null);
    if (auto) await chooseStartingSide(combat);
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
      await combat.setFlag(MODULE_ID, "currentSide", await combat.getFlag(MODULE_ID, "startingSide"));
      await ChatMessage.create({
        content: `<strong>Zipper:</strong> New round started. Priority resets to <em>${(await combat.getFlag(MODULE_ID, "startingSide"))?.toUpperCase()}</em>.`,
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

  const C = game.documents.getConstructor("Combat");

  wrap(C, "nextTurn", async function (original, ...args) {
    if (!(await this.getFlag(MODULE_ID, "enabled"))) return original(...args);
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

  const manualId = await combat.getFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
  if (opts.forceStartOfRound) acted.clear();
  let currentSide = await combat.getFlag(MODULE_ID, "currentSide");
  const startingSide = await combat.getFlag(MODULE_ID, "startingSide") ?? "pc";
  const previousSide = opts.forceStartOfRound ? null : await combat.getFlag(MODULE_ID, "currentSide");
  let nextSide = previousSide || startingSide;

  const aliveAvailOfSide = (side) => turns.filter((c) => {
    const defeated = c.isDefeated ?? c.defeated ?? false;
    if (defeated) return false;
    if (c.hidden && !game.user.isGM) return false;
    return (side === "pc") === isPC(c) && !acted.has(c.id);
  });

  const pcAvail = aliveAvailOfSide("pc");
  const npcAvail = aliveAvailOfSide("npc");

  let manualEntry = null;
  if (manualId) {
    manualEntry = turns.find((c) => c.id === manualId) ?? null;
    if (manualEntry) {
      const defeated = manualEntry.isDefeated ?? manualEntry.defeated ?? false;
      if (defeated || acted.has(manualEntry.id)) manualEntry = null;
    }
    if (!manualEntry) {
      await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
    }
  }

  if (manualEntry) {
    nextSide = isPC(manualEntry) ? "pc" : "npc";
  }

  if (!pcAvail.length && !npcAvail.length) {
    await combat.setFlag(MODULE_ID, "actedIds", []);
    await combat.setFlag(MODULE_ID, "currentSide", startingSide);
    const fresh = aliveAvailOfSide(startingSide);
    if (!fresh.length) return null;
    ChatMessage.create({
      content: `<strong>Zipper:</strong> All combatants acted. New round begins with <em>${startingSide.toUpperCase()}</em>.`,
      whisper: ChatMessage.getWhisperRecipients("GM")
    });
    return fresh[0];
  }

  if (nextSide === "pc" && !pcAvail.length) nextSide = "npc";
  if (nextSide === "npc" && !npcAvail.length) nextSide = "pc";

  let candidates = nextSide === "pc" ? pcAvail : npcAvail;
  if (!candidates.length) {
    if (manualEntry) {
      candidates = [manualEntry];
    } else {
      return null;
    }
  }

  let chosen = manualEntry ?? candidates[0];
  if (!manualEntry && nextSide === "pc" && candidates.length > 1) {
    const selection = await selectPCDialog(candidates);
    if (selection) {
      chosen = selection;
    }
  }

  if (!chosen) return null;

  const chosenSide = isPC(chosen) ? "pc" : "npc";
  await combat.setFlag(MODULE_ID, "currentSide", chosenSide);
  if (manualId) await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);

  await ChatMessage.create({
    content: `<em>Alternate Activation:</em> <strong>${chosenSide.toUpperCase()}</strong> act.`,
    speaker: { alias: "Zipper" }
  });

  return chosen;
}

/* ---------------------------------------------------------
 * Dialog for selecting next PC
 * --------------------------------------------------------- */
async function selectPCDialog(candidates) {
  const canPlayers = game.settings.get(MODULE_ID, "playersCanAdvance");
  if (!canPlayers && !game.user.isGM) {
    ui.notifications.warn("Only the GM may choose the next PC.");
    return null;
  }

  const choices = candidates.map((c, idx) => `
    <label style="display:flex;align-items:center;gap:6px;margin:4px 0;">
      <input type="radio" name="pcChoice" value="${c.id}" ${idx === 0 ? "checked" : ""}>
      <img src="${c.token?.texture?.src || c.img}" width="28" height="28" style="object-fit:cover;border-radius:4px;">
      ${c.name}
    </label>`).join("");

  return new Promise(resolve => {
    new Dialog({
      title: "Choose Next PC",
      content: `<form>${choices}</form>`,
      buttons: {
        ok: {
          label: "Activate",
          callback: (html) => {
            const id = html[0].querySelector('input[name="pcChoice"]:checked')?.value;
            const sel = candidates.find(c => c.id === id) || candidates[0];
            resolve(sel);
          }
        }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

/* ---------------------------------------------------------
 * Tracker dock rendering
 * --------------------------------------------------------- */
async function buildDockContext(combat) {
  const gm = game.user.isGM;
  const dockStyles = getDockStyleConfig();
  const base = {
    gm,
    hasCombat: !!combat,
    enabled: false,
    priorityLabel: "—",
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
    dockStyles
  };

  if (!combat) return base;

  const plan = await evaluateZipperState(combat, { preview: true });
  const effectiveNextSide = plan.display.nextSide;
  const priorityLabel = toSideLabel(plan.state.startingSide) ?? "—";
  const nextSideLabel = toSideLabel(effectiveNextSide) ?? null;
  const upcomingSideLabel = toSideLabel(plan.display.upcomingSide) ?? null;
  const ready = cloneDisplayGroup(plan.display.ready);
  const spent = cloneDisplayGroup(plan.display.spent);
  const defeated = cloneDisplayGroup(plan.display.defeated);
  const nextCandidates = (plan.display.nextCandidates ?? []).map((entry) => ({
    ...entry,
    canActivate: entry.canActivate ?? canActivateEntry(entry, effectiveNextSide, plan.allowPlayers)
  }));

  const canSelectPC = plan.enabled && canActivateEntry({ side: "pc" }, effectiveNextSide, plan.allowPlayers);
  const canSelectNPC = plan.enabled && canActivateEntry({ side: "npc" }, effectiveNextSide, plan.allowPlayers);

  return {
    gm,
    hasCombat: true,
    enabled: plan.enabled,
    priorityLabel,
    nextSideLabel,
    upcomingSideLabel,
    roundReset: plan.roundReset,
    manualPending: !!plan.state.manualChoiceId && !plan.manualUsed,
    currentCombatant: plan.display.current ?? null,
    nextCandidates,
    ready,
    spent,
    defeated,
    canSelectPC,
    canSelectNPC,
    allowPlayers: plan.allowPlayers,
    combatId: combat.id,
    nextSide: effectiveNextSide,
    dockStyles
  };
}

function bindDockListeners(wrapper) {
  wrapper.off("click.wng-zipper");
  wrapper.on("click.wng-zipper", "button[data-action]", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const action = button.dataset.action;
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
        case "set-priority":
          await handleSetPriority(combat, button.dataset.side);
          break;
        case "activate":
          await handleManualActivation(combat, button.dataset.combatantId);
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
  const rendered = await renderTemplate(DOCK_TEMPLATE, context);
  root.html(`<div class="${DOCK_WRAPPER_CLASS}">${rendered}</div>`);
  bindDockListeners(root);
  root.toggleClass("is-active", !!context.enabled);
  root.toggleClass("has-combat", !!context.hasCombat);
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
  await combat.setFlag(MODULE_ID, "enabled", !enabled);
  if (!enabled && !(await combat.getFlag(MODULE_ID, "startingSide"))) {
    await chooseStartingSide(combat);
  }
  ui.combat.render(true);
  requestDockRender();
}

async function handleSetPriority(combat, side) {
  if (!side || !["pc", "npc"].includes(side)) return;
  await combat.setFlag(MODULE_ID, "startingSide", side);
  await combat.setFlag(MODULE_ID, "currentSide", side);
  await combat.setFlag(MODULE_ID, "actedIds", []);
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
  const candidates = plan.display.nextCandidates ?? [];
  const candidate = candidates.find((c) => c.id === combatantId);
  if (!candidate || !canActivateEntry(candidate, plan.display.nextSide, plan.allowPlayers)) {
    ui.notifications.warn("That combatant cannot act right now.");
    return;
  }

  await combat.setFlag(MODULE_ID, MANUAL_CHOICE_FLAG, combatantId);
  await combat.nextTurn();
  ui.combat.render(true);
  requestDockRender();
}

Hooks.on("renderCombatTracker", async (app, html) => {
  requestDockRender();
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
      await c.setFlag(MODULE_ID, "enabled", !!on);
      if (on && !(await c.getFlag(MODULE_ID, "startingSide"))) await chooseStartingSide(c);
      ui.combat.render(); return true;
    },
    async setPriority(side = "pc") {
      const c = game.combat; if (!c) return false;
      if (!["pc", "npc"].includes(side)) return false;
      await c.setFlag(MODULE_ID, "startingSide", side);
      await c.setFlag(MODULE_ID, "currentSide", side);
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
