/*******************************************************************************************
 * Wrath & Glory — Zipper Initiative for Foundry VTT
 * Author: Ariel Cember + GPT-5
 * Version: 0.2.0
 * 
 * Implements strict alternate-activation (PC↔NPC) initiative with a Priority side each round.
 * When multiple PCs are eligible, players choose who acts next.
 * GM always retains override authority. Falls back to default Foundry initiative if disabled.
 *******************************************************************************************/

const MODULE_ID = "wng-zipper";
const MANUAL_CHOICE_FLAG = "manualChoice";

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

const parseManualFlag = (flag) => {
  if (!flag) return null;
  if (typeof flag === "string") return { id: flag, side: null, override: false };
  if (typeof flag === "object") {
    const id = flag.id ?? flag.combatantId ?? null;
    if (!id) return null;
    return {
      id,
      side: flag.side ?? null,
      override: !!flag.override
    };
  }
  return null;
};

async function evaluateZipperState(combat, opts = {}) {
  const preview = !!opts.preview;
  const forceStart = !!opts.forceStartOfRound;
  const enabled = await combat.getFlag(MODULE_ID, "enabled");
  const startingSide = await combat.getFlag(MODULE_ID, "startingSide") ?? "pc";
  const currentSideFlag = forceStart ? null : await combat.getFlag(MODULE_ID, "currentSide");
  const manualFlag = await combat.getFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  const manualState = parseManualFlag(manualFlag);
  const plan = {
    preview,
    enabled,
    rawManualChoiceId: manualFlag,
    state: {
      startingSide,
      currentSide: currentSideFlag,
      actedIds: [],
      manualChoiceId: manualState?.id ?? null,
      manualSide: manualState?.side ?? null,
      manualOverride: !!manualState?.override,
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
      manualChoiceId: manualState?.id ?? null
    },
    choice: null,
    manualUsed: false,
    needsChoice: false,
    clearActed: !!forceStart,
    roundReset: false,
    roundResetMessage: null,
    announceMessage: null,
    allowPlayers: game.settings.get(MODULE_ID, "playersCanAdvance"),
    clearManual: false
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
  let manualEntry = manualState ? entries.find(e => e.id === manualState.id && !e.isDefeated && !acted.has(e.id)) : null;
  if (!manualEntry && manualState) {
    plan.clearManual = true;
    plan.state.manualChoiceId = null;
    plan.display.manualChoiceId = null;
  } else if (manualEntry) {
    plan.state.manualSide = manualEntry.side;
  }

  const manualOverride = !!manualState?.override && !!manualEntry;

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
  } else if (manualOverride) {
    nextSide = manualEntry.side;
    options = [manualEntry];
    choice = manualEntry;
    plan.manualUsed = true;
    const opposingAvailable = manualEntry.side === "pc" ? npcAvail.length > 0 : pcAvail.length > 0;
    plan.display.upcomingSide = opposingAvailable ? (manualEntry.side === "pc" ? "npc" : "pc") : manualEntry.side;
    if (!plan.roundReset) {
      plan.announceMessage = `<em>Alternate Activation:</em> <strong>${nextSide.toUpperCase()}</strong> act.`;
    }
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
  plan.state.manualSide = manualEntry ? manualEntry.side : null;
  plan.state.manualOverride = manualOverride && !!manualEntry;
  plan.display.manualChoiceId = plan.state.manualChoiceId;
  plan.display.nextCandidates = options.filter(e => !e.hidden || game.user.isGM).map(e => sanitizeEntry(e, plan.state.manualChoiceId));
  plan.display.nextSide = options.length ? nextSide : null;
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
      await this.setTurn(nextCombatant.id);
      return this;
    }

    const idx = this.turns.findIndex(t => t.id === nextCombatant.id);
    if (idx < 0) return original(...args);
    await this.update({ turn: idx });
    return this;
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
  const plan = await evaluateZipperState(combat, opts);
  if (!plan.enabled) return null;
  if (!plan.entries.length) return null;

  if (plan.clearManual && plan.rawManualChoiceId) {
    await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  }

  if (plan.roundReset) {
    if (plan.clearActed) await combat.setFlag(MODULE_ID, "actedIds", []);
    await combat.setFlag(MODULE_ID, "currentSide", plan.state.upcomingSide ?? plan.state.startingSide);
    if (plan.rawManualChoiceId) await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
    if (plan.roundResetMessage) {
      await ChatMessage.create({
        content: plan.roundResetMessage,
        whisper: ChatMessage.getWhisperRecipients("GM")
      });
    }
    return plan.choice?.doc ?? null;
  }

  let chosen = plan.choice?.doc ?? null;
  if (!chosen) {
    if (plan.needsChoice) {
      const selection = await selectPCDialog(plan.options.map(o => o.doc));
      if (!selection) return null;
      chosen = selection;
    } else {
      return null;
    }
  }

  if (plan.clearActed) await combat.setFlag(MODULE_ID, "actedIds", []);
  await combat.setFlag(MODULE_ID, "currentSide", plan.state.upcomingSide ?? plan.state.nextSide ?? plan.state.startingSide);
  if (plan.manualUsed || plan.rawManualChoiceId) await combat.unsetFlag(MODULE_ID, MANUAL_CHOICE_FLAG);
  if (plan.announceMessage) {
    await ChatMessage.create({
      content: plan.announceMessage,
      speaker: { alias: "Zipper" }
    });
  }

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
 * UI quality-of-life
 * --------------------------------------------------------- */
const sideLabel = (side) => side === "npc" ? "NPCs" : "PCs";

Hooks.on("renderCombatTracker", async (app, html) => {
  html.find(".directory-header .zipper-hint").remove();
  html.find(".directory-header").next(".wng-zipper-tracker").remove();

  const combat = game.combat;
  if (!combat) return;

  const plan = await evaluateZipperState(combat, { preview: true });
  const gm = game.user.isGM;
  const canSelectPC = plan.display.nextSide === "pc" && (plan.allowPlayers || gm);
  const canSelectNPC = plan.display.nextSide === "npc" && gm;
  const allowActivate = (entry) => {
    if (!entry) return false;
    if (entry.hidden || entry.isDefeated) return false;
    if (gm) return true;
    if (entry.side === "pc") return canSelectPC;
    if (entry.side === "npc") return canSelectNPC;
    return false;
  };
  const mapActivatable = (list = []) => list.map((entry) => ({ ...entry, canActivate: allowActivate(entry) }));
  const context = {
    enabled: plan.enabled,
    hasCombat: !!combat,
    prioritySide: plan.state.startingSide,
    priorityLabel: sideLabel(plan.state.startingSide),
    currentSide: plan.state.currentSide,
    currentSideLabel: plan.state.currentSide ? sideLabel(plan.state.currentSide) : null,
    nextSide: plan.display.nextSide,
    nextSideLabel: plan.display.nextSide ? sideLabel(plan.display.nextSide) : null,
    upcomingSide: plan.display.upcomingSide,
    upcomingSideLabel: plan.display.upcomingSide ? sideLabel(plan.display.upcomingSide) : null,
    ready: {
      pc: mapActivatable(plan.display.ready.pc),
      npc: mapActivatable(plan.display.ready.npc)
    },
    spent: plan.display.spent,
    defeated: plan.display.defeated,
    currentCombatant: plan.display.current,
    nextCandidates: mapActivatable(plan.display.nextCandidates),
    allowPriorityChange: game.user.isGM,
    allowPlayerAdvance: plan.allowPlayers,
    manualChoiceId: plan.display.manualChoiceId,
    manualPending: plan.enabled && !!plan.display.manualChoiceId && !plan.manualUsed,
    canSelectPC,
    canSelectNPC,
    gm,
    gmCanActivateAny: gm,
    roundReset: plan.roundReset,
    moduleId: MODULE_ID
  };

  const rendered = await renderTemplate(`modules/${MODULE_ID}/templates/zipper-tracker.hbs`, context);
  const tracker = $(rendered);

  tracker.on("click", "[data-action='set-priority']", async (event) => {
    event.preventDefault();
    const side = event.currentTarget.dataset.side;
    if (!side || !game.user.isGM) return;
    await combat.setFlag(MODULE_ID, "startingSide", side);
    await combat.setFlag(MODULE_ID, "currentSide", side);
    ui.combat.render(true);
  });

  tracker.on("click", "[data-action='toggle-module']", async (event) => {
    event.preventDefault();
    if (!game.user.isGM) return;
    const current = await combat.getFlag(MODULE_ID, "enabled");
    await combat.setFlag(MODULE_ID, "enabled", !current);
    if (!current && !(await combat.getFlag(MODULE_ID, "startingSide"))) {
      await chooseStartingSide(combat);
    }
    ui.combat.render(true);
  });

  tracker.on("click", "[data-action='activate']", async (event) => {
    event.preventDefault();
    const id = event.currentTarget.dataset.combatantId;
    if (!id) return;
    if (!(await combat.getFlag(MODULE_ID, "enabled"))) return;
    const side = event.currentTarget.dataset.side;
    const entry = plan.entries.find(e => e.id === id);
    if (!entry || entry.hidden || entry.isDefeated) return;
    const isGM = game.user.isGM;
    if (side === "pc" && !(plan.allowPlayers || isGM)) return;
    if (side === "npc" && !isGM) return;
    const override = isGM && plan.display.nextSide && plan.display.nextSide !== entry.side;
    await combat.setFlag(MODULE_ID, MANUAL_CHOICE_FLAG, {
      id,
      side: entry.side,
      override
    });
    await combat.nextTurn();
  });

  html.find(".directory-header").after(tracker);
});

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
      const target = c.combatants.get(combatantId);
      const side = target ? (isPC(target) ? "pc" : "npc") : null;
      const state = await evaluateZipperState(c, { preview: true });
      const override = !!(game.user?.isGM) && state.display.nextSide && side && side !== state.display.nextSide;
      await c.setFlag(MODULE_ID, MANUAL_CHOICE_FLAG, {
        id: combatantId,
        side,
        override
      });
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
 *******************************************************************************************
(async () => {
  const mod = game.modules.get(MODULE_ID);
  if (!mod?.active) return ui.notifications.error("wng-zipper not active.");
  const c = game.combat; if (!c) return ui.notifications.warn("No active combat.");
  const on = !(await c.getFlag(MODULE_ID, "enabled"));
  await mod.api.enableForActiveCombat(on);
  ui.notifications.info(`Zipper ${on ? "ENABLED" : "disabled"}.`);
})();
