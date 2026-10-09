import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type Mpegts from 'mpegts.js';

type Status = { kind: 'loading' } | { kind: 'playing' } | { kind: 'error'; message: string };

const MAX_AUTO_RETRIES = 2;

/**
 * Plays one channel through the server's /api/play proxy.
 * HLS via hls.js (or natively on Safari); falls back to mpegts.js when the
 * channel turns out to be a raw MPEG-TS stream rather than a playlist.
 */
export default function Player({ channelId, muted }: { channelId: number; muted: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current!;
    const src = `/api/play/${channelId}`;
    let hls: Hls | null = null;
    let ts: Mpegts.Player | null = null;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let autoRetries = 0;

    setStatus({ kind: 'loading' });
    const onPlaying = () => {
      if (disposed) return;
      autoRetries = 0;
      setStatus({ kind: 'playing' });
    };
    const onWaiting = () => !disposed && setStatus((s) => (s.kind === 'error' ? s : { kind: 'loading' }));
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    const fail = (message: string) => {
      if (disposed) return;
      if (autoRetries < MAX_AUTO_RETRIES) {
        autoRetries++;
        retryTimer = setTimeout(start, 1500 * autoRetries);
        return;
      }
      setStatus({ kind: 'error', message });
    };

    const play = () => void video.play().catch(() => {});

    async function startMpegts() {
      const mpegts = (await import('mpegts.js')).default;
      if (disposed) return;
      if (!mpegts.isSupported()) return fail('This browser cannot play MPEG-TS streams');
      ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
      ts.on(mpegts.Events.ERROR, (_type: string, detail: string) => fail(`Stream error (${detail})`));
      ts.attachMediaElement(video);
      ts.load();
      play();
    }

    function start() {
      hls?.destroy();
      hls = null;
      ts?.destroy();
      ts = null;
      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 4 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR || data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) {
            // Not a playlist: probably a continuous .ts stream.
            hls?.destroy();
            hls = null;
            void startMpegts();
          } else if ((data.response as { code?: number } | undefined)?.code === 415) {
            // The server saw a raw stream rather than a playlist.
            hls?.destroy();
            hls = null;
            void startMpegts();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls?.recoverMediaError();
          } else {
            const code = (data.response as { code?: number } | undefined)?.code;
            fail(code === 404 ? 'This channel no longer exists' : code === 502 ? 'Channel is offline right now' : 'Stream unavailable');
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
        void startMpegts();
      }
    }

    start();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      hls?.destroy();
      ts?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [channelId, attempt]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  return (
    <>
      <video ref={videoRef} className="player-video" muted={muted} playsInline autoPlay />
      {status.kind === 'loading' && <div className="player-status"><span className="spinner" aria-label="Loading" /></div>}
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
