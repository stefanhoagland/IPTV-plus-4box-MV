import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type Mpegts from 'mpegts.js';

type Status = { kind: 'loading' } | { kind: 'playing' } | { kind: 'error'; message: string };
type Mode = 'direct' | 'compat';

const MAX_AUTO_RETRIES = 2;
/** Give up on the direct stream if nothing plays within this long. */
const START_TIMEOUT_MS = 20_000;
/** After "playing", wait this long for decoded video frames before calling the video undecodable. */
const FRAME_CHECK_MS = 4_000;

// Channels that needed conversion, so next time they start converted straight away.
const COMPAT_KEY = 'iptvmv.compatChannels';
function rememberedCompat(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COMPAT_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function rememberCompat(id: number) {
  try {
    const s = rememberedCompat();
    s.add(id);
    localStorage.setItem(COMPAT_KEY, JSON.stringify([...s].slice(-500)));
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
 * If the browser can't decode the stream (codec errors, audio but no picture, nothing starts),
 * it switches to compat mode: the server converts the stream with ffmpeg to H.264 + AAC.
 */
export default function Player({ channelId, muted }: { channelId: number; muted: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [mode, setMode] = useState<Mode>(() => (rememberedCompat().has(channelId) ? 'compat' : 'direct'));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setMode(rememberedCompat().has(channelId) ? 'compat' : 'direct'), [channelId]);

  useEffect(() => {
    const video = videoRef.current!;
    const src = `/api/play/${channelId}`;
    let hls: Hls | null = null;
    let ts: Mpegts.Player | null = null;
    let disposed = false;
    let autoRetries = 0;
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

    const toCompat = () => {
      if (disposed || mode === 'compat') return;
      disposed = true;
      rememberCompat(channelId);
      setMode('compat');
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
      if (mode === 'direct' && convertible) return toCompat();
      clearTimers();
      setStatus({ kind: 'error', message });
      void describeStream(channelId).then((d) => d && !disposed && setStatus({ kind: 'error', message: `${message} (${d})` }));
    };

    const decodedFrames = () => video.getVideoPlaybackQuality?.().totalVideoFrames ?? (video.videoWidth > 0 ? 1 : 0);

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const onPlaying = () => {
      if (disposed) return;
      autoRetries = 0;
      if (startTimer) clearTimeout(startTimer);
      setStatus({ kind: 'playing' });
      // Audio-only playback with a black picture means the video codec isn't supported here.
      later(() => {
        if (!video.paused && video.videoWidth === 0 && decodedFrames() === 0) {
          if (mode === 'direct') toCompat();
          else setStatus({ kind: 'error', message: 'No picture in this stream' });
        }
      }, FRAME_CHECK_MS);
    };
    const onWaiting = () => !disposed && setStatus((s) => (s.kind === 'error' ? s : { kind: 'loading' }));
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    const play = () => void video.play().catch(() => {});

    async function startMpegts(url: string) {
      const mpegts = (await import('mpegts.js')).default;
      if (disposed) return;
      if (!mpegts.isSupported()) return fail('This browser cannot play this stream');
      ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
      ts.on(mpegts.Events.ERROR, (type: string, detail: string) => {
        // Media errors are decode/codec problems: conversion fixes those, retrying doesn't.
        if (type === mpegts.ErrorTypes.MEDIA_ERROR && mode === 'direct') return toCompat();
        fail(mode === 'compat' ? 'Could not convert this stream' : `Stream error (${detail})`);
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

      if (mode === 'compat') return void startMpegts(`${src}/compat`);

      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 4 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          const codecProblem =
            data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
            data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
            data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_PARSING_ERROR;
          if (codecProblem) return toCompat();
          if (!data.fatal) return;
          const code = (data.response as { code?: number } | undefined)?.code;
          if (data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR || code === 415) {
            // Not a playlist: a raw MPEG-TS stream.
            hls?.destroy();
            hls = null;
            void startMpegts(src);
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls?.recoverMediaError();
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
  }, [muted]);

  return (
    <>
      <video ref={videoRef} className="player-video" muted={muted} playsInline autoPlay />
      {mode === 'compat' && status.kind === 'playing' && (
        <span className="compat-badge" title="Your browser can't play this channel's format directly, so the server is converting it">
          Converted
        </span>
      )}
      {status.kind === 'loading' && (
        <div className="player-status">
          <span className="spinner" aria-label="Loading" />
          {mode === 'compat' && <small className="muted">Converting for your browser…</small>}
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
