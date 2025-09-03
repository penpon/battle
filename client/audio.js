(function(){
  try {
    // Single instance guard per page
    if (window.__bgmAttached) return;
    window.__bgmAttached = true;

    const SRC = '/sounds/backmusic.mp3';
    const LS_KEY_MUTED = 'bgmMuted';
    const LS_KEY_VOL = 'bgmVolume';

    const audio = new Audio(SRC);
    audio.loop = true;
    audio.preload = 'auto';

    // Restore persisted prefs (no UI; just carry-over if something else sets it)
    try {
      const muted = localStorage.getItem(LS_KEY_MUTED);
      if (muted === 'true') audio.muted = true;
      const vol = localStorage.getItem(LS_KEY_VOL);
      if (vol != null) {
        const v = Math.min(1, Math.max(0, Number(vol)));
        if (!Number.isNaN(v)) audio.volume = v;
      } else {
        audio.volume = 0.4; // default moderate volume
      }
    } catch { audio.volume = 0.4; }

    // Expose minimal controls for future use (no UI changes here)
    window.APP_BGM = {
      get element(){ return audio; },
      play: () => audio.play().catch(()=>{}),
      pause: () => { try { audio.pause(); } catch {} },
      muted: (v) => {
        if (typeof v === 'boolean') {
          audio.muted = v; try { localStorage.setItem(LS_KEY_MUTED, String(v)); } catch {}
        }
        return audio.muted;
      },
      volume: (v) => {
        if (typeof v === 'number' && isFinite(v)) {
          const nv = Math.min(1, Math.max(0, v));
          audio.volume = nv; try { localStorage.setItem(LS_KEY_VOL, String(nv)); } catch {}
        }
        return audio.volume;
      }
    };

    const tryPlay = () => {
      audio.play()
        .then(() => {
          // Once started, we can remove unlock listeners
          detach();
          // Keep looping forever
        })
        .catch(() => {
          // Autoplay may be blocked; wait for user gesture
        });
    };

    const onGesture = () => tryPlay();
    const onVisibility = () => { if (!document.hidden) tryPlay(); };

    const attach = () => {
      document.addEventListener('pointerdown', onGesture, { once: false, passive: true });
      document.addEventListener('touchstart', onGesture, { once: false, passive: true });
      document.addEventListener('click', onGesture, { once: false, passive: true });
      document.addEventListener('keydown', onGesture, { once: false });
      document.addEventListener('visibilitychange', onVisibility);
    };
    const detach = () => {
      document.removeEventListener('pointerdown', onGesture);
      document.removeEventListener('touchstart', onGesture);
      document.removeEventListener('click', onGesture);
      document.removeEventListener('keydown', onGesture);
      document.removeEventListener('visibilitychange', onVisibility);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryPlay);
    } else {
      tryPlay();
    }
    attach();
  } catch (e) {
    try { console.error('[bgm] init error', e); } catch {}
  }
})();
