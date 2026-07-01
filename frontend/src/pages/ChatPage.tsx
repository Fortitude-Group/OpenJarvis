import { useState, useEffect, useRef } from 'react';
import { MessageSquare, Cpu, Maximize2, Minimize2 } from 'lucide-react';
import { ChatArea } from '../components/Chat/ChatArea';
import { SystemPanel } from '../components/Chat/SystemPanel';
import { useAppStore } from '../lib/store';

// The JARVIS HUD is a standalone canvas page. We show it in an iframe so it lives
// inside the main window as a switchable tab.
//
// CRITICAL — load it SAME-ORIGIN, not from the backend. The HUD page ships in the
// app's own bundle (public/jarvis-hud.html → dist/jarvis-hud.html), so `/jarvis-
// hud.html` resolves to the app origin (http://tauri.localhost on Windows). We do
// NOT point the iframe at http://127.0.0.1:8000/jarvis-hud.html: WebView2 blocks a
// cross-origin sub-frame navigation from the app origin to a loopback IP (Private
// Network Access), which surfaces as "ERR_CONNECTION_REFUSED" even though the
// backend is up — that's why the standalone web HUD loads but the in-app iframe
// refused. The Chat tab works because it reaches the backend via fetch (CORS),
// not via frame navigation. So: load the HUD same-origin, and let the HUD fetch
// the backend (it sets API='http://127.0.0.1:8000'; CORS allows tauri.localhost).
//
// Health is still polled against the backend (a cross-origin fetch, which IS
// allowed) so we only mount the HUD once the lazily-booted backend is ready.
const BACKEND = 'http://127.0.0.1:8000';
const HUD_SRC = '/jarvis-hud.html'; // same-origin: served from the app's own bundle

type Tab = 'chat' | 'hud';

function HudFrame() {
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0); // bump to force a re-poll / reload
  const startedAt = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setReady(false);
    startedAt.current = Date.now();
    const poll = async () => {
      try {
        const r = await fetch(`${BACKEND}/health`, { cache: 'no-store' });
        if (!cancelled && r.ok) {
          setReady(true);
          return;
        }
      } catch {
        /* backend not up yet */
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt]);

  if (!ready) {
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6"
        style={{ background: '#02060a', color: '#39d8ff' }}
      >
        <div className="text-sm font-mono animate-pulse">Bringing JARVIS online…</div>
        <div className="text-xs" style={{ color: 'rgba(57,216,255,0.6)' }}>
          waiting for the local backend ({BACKEND.replace('http://', '')})
        </div>
        <button
          onClick={() => setAttempt((a) => a + 1)}
          className="text-xs px-3 py-1.5 rounded-full transition-colors"
          style={{ border: '1px solid rgba(57,216,255,0.4)', color: '#39d8ff' }}
        >
          ↻ Retry now
        </button>
      </div>
    );
  }

  return (
    <iframe
      key={attempt}
      title="JARVIS HUD"
      src={HUD_SRC}
      allow="microphone; autoplay; clipboard-write"
      className="block"
      style={{ border: 0, background: '#02060a', width: '100%', height: '100%', maxWidth: '100%' }}
    />
  );
}

export function ChatPage() {
  const systemPanelOpen = useAppStore((s) => s.systemPanelOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const [tab, setTab] = useState<Tab>('hud'); // JARVIS HUD is the default view
  const [hudFull, setHudFull] = useState(false);

  // Toggle the native window into borderless fullscreen (no window chrome).
  const setWinFullscreen = async (on: boolean) => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFullscreen(on);
    } catch {
      /* non-Tauri / permission missing — overlay still hides app chrome */
    }
  };
  const enterFull = () => {
    setTab('hud');
    setSidebarOpen(false);
    setHudFull(true);
    void setWinFullscreen(true);
  };
  const exitFull = () => {
    setHudFull(false);
    void setWinFullscreen(false);
  };

  // Esc exits fullscreen (fires when focus is in the app frame, not the HUD iframe).
  useEffect(() => {
    if (!hudFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitFull();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hudFull]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabBtn = (id: Tab, label: string, Icon: typeof MessageSquare) => {
    const active = tab === id;
    return (
      <button
        onClick={() => setTab(id)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-t-md transition-colors"
        style={{
          color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
          borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
          background: active ? 'var(--color-bg-secondary)' : 'transparent',
        }}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Tab strip — hidden in fullscreen HUD mode */}
        {!hudFull && (
          <div
            className="flex items-center gap-1 px-3 pt-2 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            {tabBtn('hud', 'JARVIS HUD', Cpu)}
            {tabBtn('chat', 'Chat', MessageSquare)}
            {tab === 'hud' && (
              <button
                onClick={enterFull}
                title="Fullscreen HUD (Esc to exit)"
                className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors"
                style={{ color: 'var(--color-text-tertiary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-tertiary)')}
              >
                <Maximize2 size={13} /> Fullscreen
              </button>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden">
          <div
            className="absolute inset-0"
            style={{ display: tab === 'chat' && !hudFull ? 'block' : 'none' }}
          >
            <ChatArea />
          </div>
          {(tab === 'hud' || hudFull) && <HudFrame />}
          {hudFull && (
            <button
              onClick={exitFull}
              title="Exit fullscreen (Esc)"
              className="absolute top-3 right-3 z-50 flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md"
              style={{
                background: 'rgba(8,22,30,0.7)',
                border: '1px solid rgba(57,216,255,0.4)',
                color: '#39d8ff',
                backdropFilter: 'blur(4px)',
              }}
            >
              <Minimize2 size={13} /> Exit
            </button>
          )}
        </div>
      </div>
      {systemPanelOpen && tab === 'chat' && !hudFull && <SystemPanel />}
    </div>
  );
}
