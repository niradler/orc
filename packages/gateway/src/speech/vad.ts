export const VOICE_SAMPLE_RATE = 16_000;
const FRAME = VOICE_SAMPLE_RATE / 50;
const FRAME_MS = 20;
const ONSET_FRAMES = 3;
const PREROLL_FRAMES = 15;
const MIN_VOICED_MS = 200;
const MAX_TURN_MS = 60_000;

export type TurnEvent = { type: "start" } | { type: "end"; audio: Int16Array | null };

export function createTurnDetector({
  silenceMs,
  thresholdDb,
}: {
  silenceMs: number;
  thresholdDb: number;
}) {
  let pending = new Int16Array(0);
  let preroll: Int16Array[] = [];
  let turn: Int16Array[] | null = null;
  let onset = 0;
  let silent = 0;
  let voicedMs = 0;

  const level = (frame: Int16Array) => {
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    return 20 * Math.log10(Math.sqrt(sum / frame.length) / 32768 || 1e-9);
  };

  const finish = (): TurnEvent => {
    const frames = turn ?? [];
    turn = null;
    onset = 0;
    silent = 0;
    const audio = new Int16Array(frames.length * FRAME);
    frames.forEach((frame, index) => {
      audio.set(frame, index * FRAME);
    });
    const voiced = voicedMs >= MIN_VOICED_MS;
    voicedMs = 0;
    return { type: "end", audio: voiced ? audio : null };
  };

  return {
    push(pcm: Int16Array): TurnEvent[] {
      const events: TurnEvent[] = [];
      const samples = new Int16Array(pending.length + pcm.length);
      samples.set(pending);
      samples.set(pcm, pending.length);
      let offset = 0;
      for (; offset + FRAME <= samples.length; offset += FRAME) {
        const frame = samples.slice(offset, offset + FRAME);
        const loud = level(frame) > thresholdDb;
        if (!turn) {
          preroll.push(frame);
          if (preroll.length > PREROLL_FRAMES) preroll.shift();
          onset = loud ? onset + 1 : 0;
          if (onset >= ONSET_FRAMES) {
            turn = preroll;
            preroll = [];
            voicedMs = onset * FRAME_MS;
            events.push({ type: "start" });
          }
          continue;
        }
        turn.push(frame);
        if (loud) {
          silent = 0;
          voicedMs += FRAME_MS;
        } else silent += FRAME_MS;
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
