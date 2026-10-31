// Chats know the date but not the user's time zone, so they gave times the
// way servers, logs and APIs print them: in UTC. They are told the Mac's
// time zone and to give every time in it. Pure (no electron imports) so it
// can be tested on its own.

// the Mac's time zone, as an IANA name ("America/New_York") and its short
// name at `now` ("EDT", or "EST" in winter)
export function localZone(now = new Date(), zone?: string): { id: string; short: string } {
  const id = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const short =
    new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? id;
  return { id, short };
}

// "5:38 PM EDT"
export function localTime(now = new Date(), zone?: string): string {
  const { id, short } = localZone(now, zone);
  const clock = now.toLocaleTimeString("en-US", { timeZone: id, hour: "numeric", minute: "2-digit" });
  return `${clock} ${short}`;
}

// Claude Code gets this in its system prompt; other engines in a note on
// their first message. No clock time in it: a system prompt that changed
// every message would cost the chat its prompt cache.
export function timeZoneGuide(now = new Date(), zone?: string): string {
  const { id, short } = localZone(now, zone);
  return (
    `The user's time zone is ${id} (${short} right now). Give every time in it, like 3:05 PM ${short}, ` +
    "converting times that tools, logs, servers and APIs report in UTC. Do not give times in UTC."
  );
}
