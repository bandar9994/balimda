// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Fitting a chat into an on-device model's context window.

// Rough token count: about 3 letters per token for English, but Arabic and
// other non-Latin scripts get far fewer letters per token, so they count more.
export function estimateTokens(text) {
  let latin = 0;
  let other = 0;
  for (const ch of String(text || '')) {
    if (ch.charCodeAt(0) < 128) latin++;
    else other++;
  }
  return Math.ceil(latin / 3 + other / 1.5);
}

// A picture takes up to about this many tokens (the phone engine scales
// bigger ones down to it).
export const PICTURE_TOKENS = 1024;

// Keep the newest messages that fit, always leaving room for the reply.
export function fitToContext(messages, system, ctx, replyTokens) {
  const budget = Math.max(256, ctx - replyTokens - 64);
  let used = estimateTokens(system);
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    used += estimateTokens(messages[i].content) + 8 + (messages[i].images || []).length * PICTURE_TOKENS;
    if (used > budget && kept.length) break;
    kept.unshift(messages[i]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}
