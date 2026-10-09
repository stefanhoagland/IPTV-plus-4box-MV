import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type Mpegts from 'mpegts.js';

type Status = { kind: 'loading' } | { kind: 'playing' } | { kind: 'error'; message: string };
/** direct: the channel as-is. compat: server fixes the audio and only re-encodes video it knows the
 *  browser can't play. reencode: server always re-encodes the video (pictures that stay black anyway). */
type Mode = 'direct' | 'compat' | 'reencode';
const NEXT_MODE: Record<Mode, Mode | null> = { direct: 'compat', compat: 'reencode', reencode: null };

const MAX_AUTO_RETRIES = 2;
/** Give up on the direct stream if nothing plays within this long. */
const START_TIMEOUT_MS = 20_000;
/** After "playing", wait this long for pictures on screen before calling the video undecodable. */
const FRAME_CHECK_MS = 4_000;

// Channels that needed conversion, so next time they start converted straight away.
const MODES_KEY = 'iptvmv.channelModes';
const OLD_COMPAT_KEY = 'iptvmv.compatChannels';
function rememberedModes(): Record<string, Mode> {
  try {
    const modes = JSON.parse(localStorage.getItem(MODES_KEY) ?? '{}') as Record<string, Mode>;
    for (const id of JSON.parse(localStorage.getItem(OLD_COMPAT_KEY) ?? '[]') as number[]) modes[id] ??= 'compat';
    return modes;
  } catch {
    return {};
  }
}
const rememberedMode = (id: number): Mode => rememberedModes()[id] ?? 'direct';
function rememberMode(id: number, mode: Mode) {
  try {
    const modes = rememberedModes();
    delete modes[id];
    if (mode !== 'direct') modes[id] = mode;
    localStorage.setItem(MODES_KEY, JSON.stringify(Object.fromEntries(Object.entries(modes).slice(-500))));
    localStorage.removeItem(OLD_COMPAT_KEY);
  } catch {
    /* storage unavailable: fine, we'll just detect it again */
  }
}

async function describeStream(channelId: number): Promise<string | null> {
  try {
    const res = await fetch(`/api/play/${channelId}/probe`);
    if (!res.ok) return null;
    const p = (await res.json()) as { video: { codec: string } | null; audio: { codec: string } | null };
    return [p.video && `video ${p.video.codec}`, p.audio && `audio ${p.audio.codec}`].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}

/**
 * Plays one channel through the server.
 * Direct mode: HLS via hls.js (native on Safari), or mpegts.js for raw MPEG-TS.
 * If the browser can't show the stream (codec errors, no picture on screen, nothing starts), it steps
 * up to compat and then reencode mode, where the server converts the stream with ffmpeg.
 * `fixRequest` changes when the viewer presses "Fix picture": it toggles forced re-encoding.
 */
export default function Player({ channelId, muted, fixRequest = 0 }: { channelId: number; muted: boolean; fixRequest?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [mode, setMode] = useState<Mode>(() => rememberedMode(channelId));
  const [attempt, setAttempt] = useState(0);
  const [soundBlocked, setSoundBlocked] = useState(false);

  useEffect(() => setMode(rememberedMode(channelId)), [channelId]);

  const lastFix = useRef(fixRequest);
  useEffect(() => {
    if (fixRequest === lastFix.current) return;
    lastFix.current = fixRequest;
    const next: Mode = mode === 'reencode' ? 'direct' : 'reencode';
    rememberMode(channelId, next);
    setMode(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixRequest]);

  useEffect(() => {
    const video = videoRef.current!;
    const src = `/api/play/${channelId}`;
    let hls: Hls | null = null;
    let ts: Mpegts.Player | null = null;
    let disposed = false;
    let autoRetries = 0;
    let mediaRecoveries = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!disposed) fn();
      }, ms);
      timers.add(t);
    };
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };

    /** Move on to the next conversion level. Returns false when there is none left. */
    const stepUp = () => {
      if (disposed) return true;
      const next = NEXT_MODE[mode];
      if (!next) return false;
      disposed = true;
      rememberMode(channelId, next);
      setMode(next);
      return true;
    };

    const showError = (message: string) => {
      clearTimers();
      setStatus({ kind: 'error', message });
      void describeStream(channelId).then((d) => d && !disposed && setStatus({ kind: 'error', message: `${message} (${d})` }));
    };

    /** `convertible`: false for problems conversion can't fix (channel offline or gone). */
    const fail = (message: string, convertible = true) => {
      if (disposed) return;
      if (autoRetries < MAX_AUTO_RETRIES) {
        autoRetries++;
        clearTimers();
        later(start, 1500 * autoRetries);
        return;
      }
      if (mode === 'direct' && convertible && stepUp()) return;
      showError(message);
    };

    /** Codec or decode problems: retrying the same way won't help, converting might. */
    const undecodable = (message: string) => {
      if (disposed || stepUp()) return;
      showError(message);
    };

    // Count pictures actually put on screen. A playing video with none is a black box.
    let shownFrames = 0;
    const rvfc = typeof video.requestVideoFrameCallback === 'function';
    let rvfcHandle: number | undefined;
    const onFrame = () => {
      shownFrames++;
      if (!disposed) rvfcHandle = video.requestVideoFrameCallback(onFrame);
    };
    if (rvfc) rvfcHandle = video.requestVideoFrameCallback(onFrame);
    const hasPicture = () => {
      if (rvfc) return shownFrames > 0;
      return video.videoWidth > 0 && (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 1) > 0;
    };
    // Browsers skip painting hidden videos, so only judge while this one can be seen.
    const onScreen = () => document.visibilityState === 'visible' && (!document.fullscreenElement || document.fullscreenElement.contains(video));

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    const checkPicture = (since: number) => {
      if (video.paused || hasPicture()) return void (checking = false);
      if (!onScreen() || video.currentTime - since < 1) return later(() => checkPicture(since), FRAME_CHECK_MS);
      checking = false;
      undecodable('No picture in this stream');
    };
    const onPlaying = () => {
      if (disposed) return;
      autoRetries = 0;
      if (startTimer) clearTimeout(startTimer);
      setStatus({ kind: 'playing' });
      if (checking) return;
      checking = true;
      const since = video.currentTime;
      later(() => checkPicture(since), FRAME_CHECK_MS);
    };
    const onWaiting = () => !disposed && setStatus((s) => (s.kind === 'error' ? s : { kind: 'loading' }));
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    const play = () =>
      void video.play().catch((err: DOMException) => {
        // Chrome won't start a video with sound until the page has been clicked: start it muted instead.
        if (disposed || err.name !== 'NotAllowedError' || video.muted) return;
        video.muted = true;
        setSoundBlocked(true);
        void video.play().catch(() => {});
      });

    async function startMpegts(url: string) {
      const mpegts = (await import('mpegts.js')).default;
      if (disposed) return;
      if (!mpegts.isSupported()) return fail('This browser cannot play this stream');
      ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
      ts.on(mpegts.Events.ERROR, (type: string, detail: string) => {
        if (type === mpegts.ErrorTypes.MEDIA_ERROR) return undecodable(`This stream can't be decoded (${detail})`);
        fail(mode === 'direct' ? `Stream error (${detail})` : 'Could not convert this stream');
      });
      ts.attachMediaElement(video);
      ts.load();
      play();
    }

    function start() {
      hls?.destroy();
      hls = null;
      ts?.destroy();
      ts = null;
      setStatus({ kind: 'loading' });
      if (startTimer) clearTimeout(startTimer);
      startTimer = setTimeout(() => !disposed && video.readyState < 3 && fail('Stream did not start'), START_TIMEOUT_MS);
      timers.add(startTimer);

      if (mode !== 'direct') return void startMpegts(`${src}/compat${mode === 'reencode' ? '?reencode=1' : ''}`);

      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 4 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          const codecProblem =
            data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
            data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
            data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_PARSING_ERROR;
          if (codecProblem) return undecodable(`This stream can't be decoded (${data.details})`);
          if (!data.fatal) return;
          const code = (data.response as { code?: number } | undefined)?.code;
          if (data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR || code === 415) {
            // Not a playlist: a raw MPEG-TS stream.
            hls?.destroy();
            hls = null;
            void startMpegts(src);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // One recovery for a hiccup; a decoder that keeps failing needs conversion.
            if (mediaRecoveries++ < 1) hls?.recoverMediaError();
            else undecodable(`This stream can't be decoded (${data.details})`);
          } else {
            if (code === 404 || code === 502) fail(code === 404 ? 'This channel no longer exists' : 'Channel is offline right now', false);
            else fail('Stream unavailable');
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.loadSource(`${src}?as=hls`);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.onerror = () => fail('Stream unavailable');
        play();
      } else {
        void startMpegts(src);
      }
    }

    start();
    return () => {
      disposed = true;
      clearTimers();
      if (rvfcHandle !== undefined) video.cancelVideoFrameCallback(rvfcHandle);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.onerror = null;
      hls?.destroy();
      ts?.destroy();
      video.removeAttribute('src');
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, attempt, mode]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
    if (muted) setSoundBlocked(false);
  }, [muted]);

  return (
    <>
      <video ref={videoRef} className="player-video" muted={muted} playsInline autoPlay />
      {mode !== 'direct' && status.kind === 'playing' && (
        <span className="compat-badge" title="Your browser can't play this channel's format directly, so the server is converting it">
          Converted
        </span>
      )}
      {soundBlocked && !muted && (
        <button
          className="sound-blocked"
          onClick={(e) => {
            e.stopPropagation();
            const v = videoRef.current;
            if (v) v.muted = false;
            setSoundBlocked(false);
          }}
        >
          Click for sound
        </button>
      )}
      {status.kind === 'loading' && (
        <div className="player-status">
          <span className="spinner" aria-label="Loading" />
          {mode !== 'direct' && <small className="muted">Converting for your browser…</small>}
        </div>
      )}
      {status.kind === 'error' && (
        <div className="player-status error-state">
          <span>{status.message}</span>
          <button
            className="ghost"
            onClick={(e) => {
              e.stopPropagation();
              setAttempt((a) => a + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
    </>
  );
}
