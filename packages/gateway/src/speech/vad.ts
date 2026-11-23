export const VOICE_SAMPLE_RATE = 16_000;
const FRAME = VOICE_SAMPLE_RATE / 50;
const FRAME_MS = 20;
const ONSET_FRAMES = 3;
const PREROLL_FRAMES = 15;
const MIN_VOICED_MS = 200;
const MAX_TURN_MS = 60_000;
/** A syllable gap this short does not erase barge progress: real speech dips
 *  below any floor between syllables, so a symmetric decay never adds up. */
const BARGE_HOLD_MS = 240;

export type TurnEvent =
  | { type: "start" }
  | { type: "barge" }
  /** `peakDb` is the loudest frame of the turn: the number that decides whether
   *  barge-in can ever fire in this room. `bargeBlocked` says the turn held
   *  speech but never cleared the barge gate. */
  | { type: "end"; audio: Int16Array | null; peakDb: number; bargeBlocked: boolean };

export function createTurnDetector({
  silenceMs,
  thresholdDb,
  bargeMs = 320,
  bargeMarginDb = 0,
}: {
  silenceMs: number;
  thresholdDb: number;
  /** Sustained speech above `thresholdDb + bargeMarginDb` that interrupts a
   *  spoken reply. 0 disables barge-in (half-duplex). */
  bargeMs?: number;
  /** Extra headroom over `thresholdDb` a barge must clear. Ducking already
   *  cuts the speaker echo, so the default keeps the normal floor. */
  bargeMarginDb?: number;
}) {
  let pending = new Int16Array(0);
  let preroll: Int16Array[] = [];
  let turn: Int16Array[] | null = null;
  let onset = 0;
  let silent = 0;
  let voicedMs = 0;
  let bargeVoiced = 0;
  let bargeQuiet = 0;
  let bargeSent = false;
  let speaking = false;
  let peakDb = Number.NEGATIVE_INFINITY;
  let onsetPeakDb = Number.NEGATIVE_INFINITY;

  const level = (frame: Int16Array) => {
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    return 20 * Math.log10(Math.sqrt(sum / frame.length) / 32768 || 1e-9);
  };

  const resetTurn = () => {
    turn = null;
    onset = 0;
    silent = 0;
    voicedMs = 0;
    bargeVoiced = 0;
    bargeQuiet = 0;
    bargeSent = false;
    peakDb = Number.NEGATIVE_INFINITY;
    onsetPeakDb = Number.NEGATIVE_INFINITY;
  };

  const finish = (): TurnEvent => {
    const frames = turn ?? [];
    const audio = new Int16Array(frames.length * FRAME);
    frames.forEach((frame, index) => {
      audio.set(frame, index * FRAME);
    });
    // While a reply plays, only a confirmed interruption counts as a request.
    // Anything quieter is echo or a stray knock: the client unducks and the
    // reply carries on.
    const voiced = voicedMs >= MIN_VOICED_MS && (!speaking || (bargeMs > 0 && bargeSent));
    const bargeBlocked = speaking && voicedMs >= MIN_VOICED_MS && !bargeSent;
    const loudest = Number.isFinite(peakDb) ? Math.round(peakDb * 10) / 10 : -Infinity;
    resetTurn();
    return { type: "end", audio: voiced ? audio : null, peakDb: loudest, bargeBlocked };
  };

  return {
    /** While a reply plays, a turn must reach `bargeMs` above the barge floor
     *  before it interrupts. Set false when nothing is playing. */
    setSpeaking(active: boolean) {
      speaking = active;
      bargeVoiced = 0;
      bargeQuiet = 0;
      bargeSent = false;
    },
    push(pcm: Int16Array): TurnEvent[] {
      const events: TurnEvent[] = [];
      const samples = new Int16Array(pending.length + pcm.length);
      samples.set(pending);
      samples.set(pcm, pending.length);
      let offset = 0;
      for (; offset + FRAME <= samples.length; offset += FRAME) {
        const frame = samples.slice(offset, offset + FRAME);
        const db = level(frame);
        const loud = db > thresholdDb;
        if (!turn) {
          preroll.push(frame);
          if (preroll.length > PREROLL_FRAMES) preroll.shift();
          if (loud) {
            onset += 1;
            if (db > onsetPeakDb) onsetPeakDb = db;
          } else {
            onset = 0;
            onsetPeakDb = Number.NEGATIVE_INFINITY;
          }
          if (onset >= ONSET_FRAMES) {
            turn = preroll;
            preroll = [];
            voicedMs = onset * FRAME_MS;
            peakDb = onsetPeakDb;
            onsetPeakDb = Number.NEGATIVE_INFINITY;
            events.push({ type: "start" });
          }
          continue;
        }
        if (db > peakDb) peakDb = db;
        turn.push(frame);
        if (loud) {
          silent = 0;
          voicedMs += FRAME_MS;
        } else silent += FRAME_MS;
        if (speaking && bargeMs > 0 && !bargeSent) {
          // Echo of our own speaker falls below this floor once the client ducks
          // it, so only the person in the room can sustain it. Speech still dips
          // between syllables, so a short gap holds the progress instead of
          // erasing it; only a real pause (BARGE_HOLD_MS) takes it back.
          if (db > thresholdDb + bargeMarginDb) {
            bargeVoiced += FRAME_MS;
            bargeQuiet = 0;
          } else {
            bargeQuiet += FRAME_MS;
            if (bargeQuiet >= BARGE_HOLD_MS) bargeVoiced = Math.max(0, bargeVoiced - FRAME_MS);
          }
          if (bargeVoiced >= bargeMs) {
            bargeSent = true;
            events.push({ type: "barge" });
          }
        }
        if (silent >= silenceMs || turn.length * FRAME_MS >= MAX_TURN_MS) events.push(finish());
      }
      pending = samples.slice(offset);
      return events;
    },
    flush(): TurnEvent[] {
      return turn ? [finish()] : [];
    },
  };
}

export function pcm16Wav(samples: Int16Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    view.setInt16(44 + index * 2, sample, true);
  });
  return bytes;
}
