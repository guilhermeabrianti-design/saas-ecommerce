import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils/cn';

// Tipos mínimos da API oficial de iframe do YouTube (https://developers.google.com/youtube/iframe_api_reference).
interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      host?: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: () => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('youtube_api_unavailable'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

const RATES = [0.75, 1, 1.25, 1.5, 2];
const SAVE_EVERY_MS = 15000;

/**
 * Player oficial do YouTube (domínio sem cookies). Volume, tela cheia e
 * legendas vêm dos controles do próprio YouTube; aqui ficam velocidade,
 * recomeçar e o salvamento periódico da posição.
 */
export function YouTubePlayer({
  videoId,
  startSeconds,
  onProgress,
}: {
  videoId: string;
  startSeconds: number;
  /** Chamado a cada 15 s tocando, ao pausar, ao terminar e ao sair da página. */
  onProgress: (position: number, duration: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const onProgressRef = useRef(onProgress);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const report = () => {
      const p = playerRef.current;
      if (!p) return;
      const duration = p.getDuration();
      if (duration > 0) onProgressRef.current(p.getCurrentTime(), duration);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') report();
    };

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        const mount = document.createElement('div');
        hostRef.current.replaceChildren(mount);
        playerRef.current = new YT.Player(mount, {
          videoId,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            start: Math.floor(startSeconds),
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
          },
          events: {
            onReady: () => !cancelled && setReady(true),
            onError: () => !cancelled && setFailed(true),
            onStateChange: (e) => {
              clearInterval(timer);
              if (e.data === YT.PlayerState.PLAYING) timer = setInterval(report, SAVE_EVERY_MS);
              if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) report();
            },
          },
        });
      })
      .catch(() => !cancelled && setFailed(true));

    document.addEventListener('visibilitychange', onHidden);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHidden);
      report();
      playerRef.current?.destroy();
      playerRef.current = null;
    };
    // O player é recriado só quando o vídeo muda; a posição inicial vale na criação.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  if (failed) {
    return (
      <Alert tone="error">
        <p>Não foi possível carregar o player do YouTube (bloqueador ou conexão).</p>
        <a
          href={watchUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline"
        >
          Assistir no YouTube <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <p className="text-xs">Ao voltar, marque a aula como concluída.</p>
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        <div ref={hostRef} className="absolute inset-0 [&>iframe]:size-full" />
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/70">
            Carregando vídeo…
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Velocidade:</span>
        {RATES.map((r) => (
          <button
            key={r}
            type="button"
            disabled={!ready}
            aria-pressed={rate === r}
            onClick={() => {
              playerRef.current?.setPlaybackRate(r);
              setRate(playerRef.current?.getPlaybackRate() ?? r);
            }}
            className={cn(
              'rounded-md px-2 py-1 tabular-nums disabled:opacity-50',
              rate === r ? 'bg-brand text-brand-fg' : 'hover:bg-surface-2',
            )}
          >
            {r.toLocaleString('pt-BR')}×
          </button>
        ))}
        <Button
          variant="ghost"
          className="ml-auto h-8"
          disabled={!ready}
          onClick={() => playerRef.current?.seekTo(0, true)}
        >
          <RotateCcw className="size-4" aria-hidden />
          Recomeçar
        </Button>
      </div>
    </div>
  );
}
