import { MODULE_ID } from "./constants.js";

export const log = (...args) => console.log(`[%c${MODULE_ID}%c]`, "color:#2ea043", "color:inherit", ...args);

export function extractErrorDetail(err) {
  const seen = new Set();
  let current = err;
  while (current && !seen.has(current)) {
    seen.add(current);

    if (typeof current === "string") {
      return current;
    }

    if (current instanceof Error) {
      const message = typeof current.message === "string" ? current.message.trim() : "";
      if (message) return message;
      current = current.cause ?? null;
      continue;
    }

    const message = typeof current?.message === "string" ? current.message.trim() : "";
    if (message) return message;

    current = current?.cause ?? null;
  }

  return "";
}

export function createEnrichedError(base, err) {
  const detail = extractErrorDetail(err).trim();
  const message = detail ? `${base} ${detail}` : `${base} See console for details.`;
  const enriched = new Error(message);

  if (err instanceof Error && err.stack) {
    enriched.stack = err.stack;
  }

  if (err !== undefined) {
    try {
      enriched.cause = err;
    } catch (causeError) {
      // Older environments may not allow assigning cause; ignore.
    }
  }

  return { detail, message, enriched };
}

export function reportDockActionFailure(err, { action = "dock action" } = {}) {
  const base = `Zipper ${action} failed.`;
  const { message, enriched } = createEnrichedError(base, err);

  if (err !== undefined) {
    console.error(`[%c${MODULE_ID}%c] ${message}`, "color:#2ea043", "color:inherit", err);
  } else {
    console.error(`[%c${MODULE_ID}%c] ${message}`, "color:#2ea043", "color:inherit");
  }

  const notify = ui?.notifications?.error ?? null;
  if (!notify) return;

  notify.call(ui.notifications, enriched);
}

export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}
