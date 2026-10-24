import m2ts from 'mux.js/lib/m2ts/m2ts.js';
import { H264Stream } from 'mux.js/lib/codecs/h264.js';
import type Mpegts from 'mpegts.js';

/**
 * Closed captions (CEA-608, "CC1") for raw MPEG-TS channels. US TV carries them inside the H.264 video,
 * which the browser drops, so we read them from the same bytes the player downloads (no second connection
 * to the provider) and keep a timeline of what the caption screen shows, keyed by video timestamp.
 * mux.js does the parsing; its 608 decoder internals are used directly, so mux.js is pinned.
 */

interface CaptionPacket {
  pts: number;
  type: number;
  ccData: number;
}
interface Cea608Stream {
  displayed_: string[];
}
interface CaptionStream {
  captionPackets_: CaptionPacket[];
  ccStreams_: Cea608Stream[];
  push(nal: unknown): void;
  dispatchCea608Packet(packet: CaptionPacket): void;
}

const CLOCK = 90_000;
/** Caption data comes in decode order; wait this long before using it so B-frames are put back in order. */
const REORDER = CLOCK / 2;

export class CaptionDecoder {
  private packets = new m2ts.TransportPacketStream();
  private h264 = new H264Stream();
  private cc = new m2ts.CaptionStream({ parse708captions: false }) as CaptionStream;
  private pending: CaptionPacket[] = [];
  private timeline: { pts: number; text: string }[] = [];
  private lastText = '';
  private newestPts = 0;
  /** Video timestamp (seconds) of the player's time zero. */
  private base: number | null = null;
  /** Caption data has been seen on this channel. */
  found = false;

  constructor(private video: HTMLVideoElement) {
    const parse = new m2ts.TransportParseStream();
    const es = new m2ts.ElementaryStream();
    this.packets.pipe(parse).pipe(es);
    es.on('data', (pes: { type: string; pts?: number }) => {
      if (pes.type !== 'video') return;
      if (this.base === null && pes.pts !== undefined) {
        // The newest downloaded video is about to land at the end of the buffer.
        const b = video.buffered;
        this.base = pes.pts / CLOCK - (b.length ? b.end(b.length - 1) : video.currentTime);
      }
      this.h264.push(pes);
    });
    this.h264.on('data', (nal: { pts: number }) => {
      if (nal.pts > this.newestPts) this.newestPts = nal.pts;
      this.cc.push(nal);
      if (this.cc.captionPackets_.length) {
        this.pending.push(...this.cc.captionPackets_);
        this.cc.captionPackets_.length = 0;
      }
    });
  }

  push(chunk: Uint8Array) {
    this.packets.push(chunk);
    this.decode();
  }

  private decode() {
    if (!this.pending.length) return;
    this.pending.sort((a, b) => a.pts - b.pts);
    const ready = this.pending.findIndex((p) => p.pts > this.newestPts - REORDER);
    const batch = ready === -1 ? this.pending.splice(0) : this.pending.splice(0, ready);
    for (const packet of batch) {
      if (packet.type >= 2) continue; // CEA-708 data: the 608 copy carries the same text
      this.found = true;
      this.cc.dispatchCea608Packet(packet);
      const text = this.cc.ccStreams_[0].displayed_
        .map((row) => row.replace(/<\/?[iu]>/g, '').trim())
        .filter(Boolean)
        .join('\n');
      if (text !== this.lastText) {
        this.lastText = text;
        this.timeline.push({ pts: packet.pts, text });
      }
    }
  }

  /** What the caption screen shows at the video's current position. */
  current(): string {
    if (this.base === null) return '';
    const now = (this.video.currentTime + this.base) * CLOCK;
    let i = 0;
    while (i + 1 < this.timeline.length && this.timeline[i + 1].pts <= now) i++;
    // Drop what has already been shown.
    if (i > 0) this.timeline.splice(0, i);
    const entry = this.timeline[0];
    return entry && entry.pts <= now ? entry.text : '';
  }
}

/**
 * An mpegts.js loader that downloads the stream like its own fetch loader does and also hands every chunk
 * to `onChunk`, so captions can be read without opening a second connection.
 */
export function teeLoader(mpegts: typeof Mpegts, onChunk: (chunk: Uint8Array) => void): Mpegts.CustomLoaderConstructor {
  const { LoaderStatus, LoaderErrors } = mpegts;
  const Base = mpegts.BaseLoader as unknown as new (type: string) => Record<string, unknown> & { destroy(): void };
  class TeeLoader extends Base {
    private controller: AbortController | null = null;

    constructor() {
      super('tee-fetch-loader');
      this._needStash = true;
    }

    open(dataSource: Mpegts.MediaSegment, range: Mpegts.Range) {
      const controller = new AbortController();
      this.controller = controller;
      this._status = LoaderStatus.kConnecting;
      let received = 0;
      const callback = <T extends unknown[]>(name: string, ...args: T) => (this[name] as ((...a: T) => void) | null)?.(...args);
      fetch(dataSource.url, { signal: controller.signal, credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            this._status = LoaderStatus.kError;
            return callback('_onError', LoaderErrors.HTTP_STATUS_CODE_INVALID, { code: res.status, msg: res.statusText });
          }
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) return;
            if (done) {
              this._status = LoaderStatus.kComplete;
              return callback('_onComplete', range.from, range.from + received - 1);
            }
            this._status = LoaderStatus.kBuffering;
            const byteStart = range.from + received;
            received += value.byteLength;
            try {
              onChunk(value);
            } catch {
              /* captions are best effort: never break playback */
            }
            const chunk = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.slice().buffer;
            callback('_onDataArrival', chunk, byteStart, received);
          }
        })
        .catch((err: Error) => {
          if (controller.signal.aborted) {
            this._status = LoaderStatus.kComplete;
            return;
          }
          this._status = LoaderStatus.kError;
          callback('_onError', received ? LoaderErrors.EARLY_EOF : LoaderErrors.EXCEPTION, { code: -1, msg: err.message });
        });
    }

    abort() {
      this.controller?.abort();
      this._status = LoaderStatus.kComplete;
    }

    destroy() {
      this.abort();
      super.destroy();
    }
  }
  return TeeLoader as unknown as Mpegts.CustomLoaderConstructor;
}
