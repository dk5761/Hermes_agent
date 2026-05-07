/**
 * Strip Hermes' `MEDIA:<path>` markers from assistant text.
 *
 * Mirrors the backend's tts-bridge stripper. Used at render-time on the
 * streaming text buffer so the path doesn't flash in the UI for the half-
 * second between the model emitting it and `message.complete` landing
 * (where the gateway bridge officially strips and replaces with an audio
 * bubble). After stripping, the streaming bubble's existing "..." fallback
 * paints — which reads as a generic loader.
 *
 * Keep regex / behaviour aligned with backend/src/ws/tts-bridge.ts.
 */

const MEDIA_LINE_REGEX =
  /(?:^|\n)\s*(?:\[\[audio_as_voice\]\]\s*\n)?\s*MEDIA:(\S+)\s*(?=\n|$)/g;

export function stripMediaTag(text: string): string {
  if (!text) return text;
  MEDIA_LINE_REGEX.lastIndex = 0;
  return text.replace(MEDIA_LINE_REGEX, "").replace(/\n{3,}/g, "\n\n").trim();
}
