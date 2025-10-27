import {
  MODULE_ID,
  PLAYERS_SIDE
} from "./constants.js";
import {
  canActivateEntry,
  canQueueEntry,
  computeEntryPermissions,
  isCombatantComplete,
  isPC,
  sanitizeEntry,
  toSideLabel
} from "./permissions.js";
import {
  activateCombatant,
  advanceCombatTurn,
  clearQueuedChoice,
  cloneDisplayGroup,
  cloneQueueState,
  emptyQueue,
  queuePromptBypass,
  readQueuedChoices,
  updateQueuedChoice
} from "./queue.js";
import { log } from "./utils.js";

export async function ensurePlayersLead(combat, { resetActed = false, resetCurrentSide = false } = {}) {
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
    updates.push(combat.unsetFlag(MODULE_ID, "currentSide"));
  }

  if (!updates.length) return;

  try {
    await Promise.all(updates);
  } catch (err) {
    log(err);
  }
}

export async function getStartingSide(combat) {
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

export async function evaluateZipperState(combat, opts = {}) {
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

export async function computeNextZipperCombatant(combat, opts = {}) {
  const enabled = await combat.getFlag(MODULE_ID, "enabled");
  if (!enabled) return null;

  const turns = combat.turns || [];
  if (!turns.length) return { type: "idle" };

  const acted = new Set(await combat.getFlag(MODULE_ID, "actedIds") ?? []);
  if (opts.forceStartOfRound) acted.clear();
  const startingSide = await getStartingSide(combat);
  const previousSide = opts.forceStartOfRound ? null : await combat.getFlag(MODULE_ID, "currentSide");

  const queueState = await readQueuedChoices(combat, turns);
  let queue = cloneQueueState(queueState);
  const queueEntries = { pc: null, npc: null };
  let queueChanged = false;

  for (const side of ["pc", "npc"]) {
    const queuedId = queue[side];
    if (!queuedId) continue;
    const entry = turns.find((c) => c.id === queuedId);
    if (!entry) {
      queue = { ...queue, [side]: null };
      queueChanged = true;
      continue;
    }
    const entrySide = isPC(entry) ? "pc" : "npc";
    if (entrySide !== side) {
      queue = { ...queue, [side]: null };
      queueChanged = true;
      continue;
    }
    const defeated = entry.isDefeated ?? entry.defeated ?? false;
    const complete = isCombatantComplete(entry, combat);
    if (defeated || complete || acted.has(entry.id)) {
      queue = { ...queue, [side]: null };
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
    const label = toSideLabel(startingSide) ?? startingSide.toUpperCase();
    const shouldClearQueue = queue.pc || queue.npc;
    return {
      type: "advance-round",
      queue: shouldClearQueue ? emptyQueue() : queue,
      queueChanged: queueChanged || shouldClearQueue,
      startingSide,
      message: `<strong>Zipper:</strong> All combatants acted. New round ready for <em>${label}</em>.`
    };
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
    queue = { ...queue, [nextSide]: null };
    queueChanged = true;
  } else if (candidates.length) {
    chosen = candidates[0];
  } else if (queuedCandidate) {
    chosen = queuedCandidate;
    queue = { ...queue, [nextSide]: null };
    queueChanged = true;
  }

  if (!chosen) {
    return {
      type: "idle",
      queue,
      queueChanged
    };
  }

  const chosenSide = isPC(chosen) ? "pc" : "npc";
  const label = toSideLabel(chosenSide) ?? chosenSide.toUpperCase();

  return {
    type: "activate",
    combatant: chosen,
    side: chosenSide,
    queue,
    queueChanged,
    message: `<em>Alternate Activation:</em> <strong>${label}</strong> act.`
  };
}

export async function promptNextPcQueueDialog(candidates, { preselectedId = null, allowSkip = true } = {}) {
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

export async function promptRoundAdvanceOrEnd(combat, step = {}) {
  if (!combat) return { action: "next-round" };

  const startingSide = step.startingSide ?? null;
  const label = startingSide ? (toSideLabel(startingSide) ?? startingSide.toString().toUpperCase()) : null;
  const message = step.message ? `<p>${step.message}</p>` : "";
  const prompt = label
    ? `<p>All remaining combatants are unavailable. Begin the next round so <em>${label}</em> can act first, or end combat?</p>`
    : `<p>All remaining combatants are unavailable. Begin the next round or end combat?</p>`;

  return new Promise((resolve) => {
    let resolved = false;
    new Dialog({
      title: "Round Complete",
      content: `${message}${prompt}`,
      buttons: {
        next: {
          label: "Start Next Round",
          callback: () => {
            resolved = true;
            resolve({ action: "next-round" });
          }
        },
        end: {
          label: "End Combat",
          callback: () => {
            resolved = true;
            resolve({ action: "end-combat" });
          }
        }
      },
      default: "next",
      close: () => {
        if (!resolved) resolve({ action: "next-round" });
      }
    }).render(true);
  });
}

export async function maybePromptForNextPcQueue(combat, { actingCombatant = null } = {}) {
  if (!combat) return { cancelled: false, prompted: false };
  if (!(await combat.getFlag(MODULE_ID, "enabled"))) return { cancelled: false, prompted: false };

  const current = actingCombatant ?? combat.combatant ?? null;
  if (!current || !isPC(current)) return { cancelled: false, prompted: false };

  const allowPlayers = game.settings.get(MODULE_ID, "playersCanAdvance");
  const { canControl: currentCanControl } = computeEntryPermissions(current, current.actor, current);
  if (!game.user.isGM && !(allowPlayers && currentCanControl)) return { cancelled: false, prompted: false };

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
      return computeEntryPermissions(doc, actor, entry).canControl;
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

export {
  activateCombatant,
  advanceCombatTurn,
  clearQueuedChoice,
  cloneDisplayGroup,
  cloneQueueState,
  emptyQueue,
  queuePromptBypass,
  readQueuedChoices,
  updateQueuedChoice
};
