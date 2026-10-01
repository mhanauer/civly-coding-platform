// Auto effort: each message runs at your usual level, except plain
// housekeeping (thanks, commit, push, open the PR, a status check), which
// runs at medium. "yes", "continue" and "go ahead" keep the full level:
// after a plan they usually mean "build it". Changing the level between
// messages keeps the cached conversation (checked 2026-09-29), so a lighter
// message costs less without making the next one re-read at full price.

export const AUTO = "auto";

const LIGHT = "medium";

// low to high, per engine; a level not listed is left alone
const ORDER = ["low", "medium", "high", "xhigh", "max"];

// "ok, ", "great! ", "looks good. " before the actual ask
const ACK = /^((ok|okay|great|perfect|awesome|nice|cool|good|looks good|lgtm|thanks|thank you)[,.!]*\s+)+/;

const HOUSEKEEPING: RegExp[] = [
  /^(thanks|thank you|thx|ty)( so much| a lot| again)?$/,
  /^(please )?(go ahead and )?(commit|push|commit and push|commit & push|commit, push|commit it|push it|commit this|commit that|commit these changes|commit the changes)( please)?$/,
  /^(please )?(go ahead and )?(commit and )?(open|create|make) (a|the) pr( please)?$/,
  /^(status|any updates?|is it done|done yet|still running|how'?s it going)$/
];

export function isHousekeeping(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (!text || text.length > 80 || text.includes("\n")) return false;
  const bare = text.replace(/[.!?\s]+$/, "");
  if (HOUSEKEEPING.some((re) => re.test(bare))) return true;
  // "ok" or "great" alone is an approval, which keeps the full level
  const ask = bare.replace(ACK, "").trim();
  return !!ask && HOUSEKEEPING.some((re) => re.test(ask));
}

// The level this message runs at. `usual` is your own default level.
export function resolveEffort(picked: string, prompt: string, usual: string): string {
  if (picked !== AUTO) return picked;
  if (isHousekeeping(prompt) && ORDER.indexOf(usual) > ORDER.indexOf(LIGHT)) return LIGHT;
  return usual;
}
