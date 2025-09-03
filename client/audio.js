(function(){
  try {
    // Single instance guard per page
    if (window.__bgmAttached) return;
    window.__bgmAttached = true;

    const SRC = '/sounds/backmusic.mp3';
    const LS_KEY_MUTED = 'bgmMuted';
    const LS_KEY_VOL = 'bgmVolume';
    const LS_KEY_GLOBAL_START = 'bgmGlobalStartMs';
    const LS_KEY_LAST_POS = 'bgmLastPosSec';
    const LS_KEY_LAST_TS = 'bgmLastTsMs';

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

    // Global timeline helpers (keep continuous position across pages)
    const nowMs = () => Date.now();
    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
    const ensureGlobalStartFromCurrent = () => {
      try {
        if (!localStorage.getItem(LS_KEY_GLOBAL_START)) {
          const startMs = nowMs() - Math.floor((audio.currentTime || 0) * 1000);
          localStorage.setItem(LS_KEY_GLOBAL_START, String(startMs));
        }
      } catch {}
    };
    const saveLastPos = () => {
      try {
        localStorage.setItem(LS_KEY_LAST_POS, String(audio.currentTime || 0));
        localStorage.setItem(LS_KEY_LAST_TS, String(nowMs()));
      } catch {}
    };
    const computeResumePos = (duration) => {
      try {
        const g = localStorage.getItem(LS_KEY_GLOBAL_START);
        if (g) {
          const deltaSec = (nowMs() - Number(g)) / 1000;
          if (isFinite(deltaSec) && duration > 0) {
            return ((deltaSec % duration) + duration) % duration;
          }
        }
        const lp = Number(localStorage.getItem(LS_KEY_LAST_POS));
        const lt = Number(localStorage.getItem(LS_KEY_LAST_TS));
        if (isFinite(lp) && isFinite(lt) && duration > 0) {
          const deltaSec = (nowMs() - lt) / 1000;
          const pos = lp + deltaSec;
          return ((pos % duration) + duration) % duration;
        }
      } catch {}
      return 0;
    };
    const applyResumePos = () => {
      const d = audio.duration;
      if (isFinite(d) && d > 0) {
        const pos = computeResumePos(d);
        try { audio.currentTime = clamp(pos, 0, Math.max(0, d - 0.25)); } catch {}
      }
    };

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
      // try unmuted first
      audio.play()
        .then(() => {
          detach();
          ensureGlobalStartFromCurrent();
        })
        .catch(() => {
          // Fallback: muted autoplay (allowed by browsers). We'll unmute on first gesture if user hasn't set mute preference.
          const userPrefMuted = (localStorage.getItem(LS_KEY_MUTED) === 'true');
          if (!userPrefMuted) audio.muted = true;
          audio.play()
            .then(() => {
              ensureGlobalStartFromCurrent();
            })
            .catch(() => { /* still blocked, wait for gesture */ });
        });
    };

    const onGesture = () => {
      // If we had to start muted, unmute on first user gesture unless user prefers mute
      const userPrefMuted = (localStorage.getItem(LS_KEY_MUTED) === 'true');
      if (!userPrefMuted && audio.muted) audio.muted = false;
      tryPlay();
    };
    const onVisibility = () => {
      if (document.hidden) {
        saveLastPos();
      } else {
        tryPlay();
      }
    };

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

    // Restore position once metadata is known
    audio.addEventListener('loadedmetadata', applyResumePos);
    // Periodically save position
    let lastSaveAt = 0;
    audio.addEventListener('timeupdate', () => {
      const t = performance.now();
      if (t - lastSaveAt > 3000) { lastSaveAt = t; saveLastPos(); }
    });
    // Also save on pagehide (navigation)
    window.addEventListener('pagehide', saveLastPos);

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
