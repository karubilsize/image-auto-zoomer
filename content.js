// 最大面積の画像を画面高に合わせ、遷移ごとに有限時間だけ位置を補正する。
(() => {
  'use strict';
  const MIN_AREA = 10000;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 5;
  const SCROLL_SETTLE_MS = 250;
  const RECOVERY_MS = 2000;
  const NAV_CHECK_MS = 350;
  const UPDATE_DEBOUNCE_MS = 100;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  let currentUrl = location.href;
  let navigationId = 0;
  let phase = 'waiting'; // waiting -> recovering -> done; user input -> cancelled
  let updateTimer = null;
  let scrollTimer = null;
  let deadlineTimer = null;
  let frame = null;
  let recoveryDeadline = null;
  let lastZoom = null;
  let lastZoomStyle = null;
  let commands = 0;
  let lastCandidate = null;
  let lastCandidateArea = 0;
  let pageShowHandled = false;
  let debug = false;
  try { debug = localStorage.getItem('imageAutoZoomerDebug') === '1'; } catch (_) { /* storage may be blocked */ }

  function log(event, details = {}) {
    if (debug) console.debug('[Image Auto Zoomer]', {
      event, navigationId, phase, time: Math.round(performance.now()), commands, ...details
    });
  }

  function findLargestImage() {
    let best = null;
    let maxArea = 0;
    for (const img of document.images) {
      if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) continue;
      const area = img.naturalWidth * img.naturalHeight;
      if (area < MIN_AREA || area <= maxArea) continue;
      const style = getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = img.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      best = img;
      maxArea = area;
    }
    return { img: best, area: maxArea };
  }

  function applyZoom(img) {
    const body = document.body;
    if (!body) return;
    const current = parseFloat(body.style.zoom) || 1;
    const height = img.getBoundingClientRect().height;
    if (height <= 0) return;
    const target = clamp(current * window.innerHeight / height, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(target - current) > 0.01) {
      lastZoom = String(target);
      body.style.zoom = lastZoom;
      lastZoomStyle = body.getAttribute('style');
    }
  }

  // scrollIntoView moves the whole ancestor chain, including nested scrollports.
  // Compare against each scrollport, respecting its finite scroll range and CSS offsets.
  function positions(img) {
    const result = [];
    const rect = img.getBoundingClientRect();
    const imageScale = img.offsetHeight ? rect.height / img.offsetHeight : 1;
    const margin = (parseFloat(getComputedStyle(img).scrollMarginTop) || 0) * imageScale;
    for (let el = img.parentElement; el; el = el.parentElement) {
      if (el === document.scrollingElement) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll|hidden|overlay)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight) continue;
      const box = el.getBoundingClientRect();
      const scale = el.offsetHeight ? box.height / el.offsetHeight : 1;
      const padding = parseFloat(style.scrollPaddingTop) || 0;
      result.push({
        container: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
        offset: rect.top - box.top - (el.clientTop + padding) * scale - margin,
        position: el.scrollTop, max: el.scrollHeight - el.clientHeight
      });
    }
    const root = document.scrollingElement;
    result.push({ container: 'window',
      offset: rect.top - margin - (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0),
      position: window.scrollY,
      max: root ? Math.max(0, root.scrollHeight - window.innerHeight) : 0
    });
    return result;
  }

  function needsScroll(items) {
    return items.some(p => (p.offset > 3 && p.position < p.max - 1) ||
      (p.offset < -3 && p.position > 1));
  }

  function clearScrollWork() {
    clearTimeout(scrollTimer);
    clearTimeout(deadlineTimer);
    if (frame !== null) cancelAnimationFrame(frame);
    scrollTimer = deadlineTimer = frame = null;
  }

  function finish(reason) {
    clearScrollWork();
    phase = 'done';
    const img = findLargestImage().img;
    log('finished', { reason, positions: img ? positions(img) : null });
  }

  function queueScroll(reason, delay = UPDATE_DEBOUNCE_MS) {
    if (phase !== 'waiting' && phase !== 'recovering') return;
    // One timer and one frame chain per navigation; events cannot postpone them.
    if (scrollTimer !== null || frame !== null) return;
    const id = navigationId;
    log('scroll-scheduled', { reason, delay });
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (id !== navigationId) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (id === navigationId) performScroll(reason);
        });
      });
    }, delay);
  }

  function performScroll(reason) {
    if (phase !== 'waiting' && phase !== 'recovering') return;
    if (recoveryDeadline !== null && performance.now() >= recoveryDeadline) {
      finish('recovery-deadline');
      return;
    }
    const img = findLargestImage().img;
    if (!img) { log('no-candidate', { reason }); return; }
    applyZoom(img);
    if (phase === 'waiting') {
      phase = 'recovering';
      recoveryDeadline = performance.now() + RECOVERY_MS;
      const id = navigationId;
      deadlineTimer = setTimeout(() => {
        if (id === navigationId) finish('recovery-deadline');
      }, RECOVERY_MS);
    }
    const before = positions(img);
    if (!needsScroll(before)) { log('aligned-or-constrained', { positions: before }); return; }
    commands++;
    log('scroll-command', { reason, positions: before });
    img.scrollIntoView({ behavior: 'instant', block: 'start', inline: 'nearest' });
    log('scroll-result', { positions: positions(img) });
    // Verification catches layout changes after the command without starting another loop.
    queueScroll('verify');
  }

  function update() {
    const { img, area } = findLargestImage();
    if (!img) { log('no-candidate'); return; }
    if (img !== lastCandidate || area !== lastCandidateArea) {
      lastCandidate = img;
      lastCandidateArea = area;
      log('candidate', { width: img.naturalWidth, height: img.naturalHeight, area });
    }
    applyZoom(img);
    queueScroll('update', phase === 'waiting' ? SCROLL_SETTLE_MS : UPDATE_DEBOUNCE_MS);
  }

  function scheduleUpdate() {
    // A trailing debounce can starve forever on pages with animations/mutations.
    if (updateTimer !== null) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      checkNavigation();
      update();
    }, UPDATE_DEBOUNCE_MS);
  }

  function startNavigation() {
    clearScrollWork();
    clearTimeout(updateTimer);
    updateTimer = null;
    currentUrl = location.href;
    navigationId++;
    phase = 'waiting';
    recoveryDeadline = null;
    commands = 0;
    lastCandidate = null;
    lastCandidateArea = 0;
    log('navigation', { restoration: history.scrollRestoration });
    scheduleUpdate();
  }

  function checkNavigation() {
    if (location.href !== currentUrl) startNavigation();
  }

  function cancelForUser(event) {
    // Input is user intent even immediately after our own scroll command.
    // A scroll event itself cannot distinguish the site/browser from a user.
    checkNavigation();
    if (phase === 'cancelled') return;
    clearScrollWork();
    phase = 'cancelled';
    log('user-cancelled', { input: event.type, key: event.key });
  }

  window.addEventListener('wheel', cancelForUser, { passive: true, capture: true });
  window.addEventListener('touchmove', cancelForUser, { passive: true, capture: true });
  window.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
    const target = event.composedPath()[0];
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    cancelForUser(event);
  }, true);
  window.addEventListener('pointerdown', event => {
    // Classic scrollbar gutters, including the viewport scrollbar. Ordinary clicks do not cancel.
    const el = event.target;
    if (!(el instanceof Element)) return;
    const box = el.getBoundingClientRect();
    const scale = el.offsetWidth ? box.width / el.offsetWidth : 1;
    const root = el === document.documentElement;
    const inGutter = root ? event.clientX >= document.documentElement.clientWidth :
      el.offsetWidth - el.clientWidth - el.clientLeft * 2 > 0 &&
      event.clientX >= box.left + (el.clientLeft + el.clientWidth) * scale;
    if (inGutter && (root || el.scrollHeight > el.clientHeight)) cancelForUser(event);
  }, true);

  window.addEventListener('scroll', event => {
    checkNavigation();
    if (phase !== 'recovering' && !debug) return;
    const img = findLargestImage().img;
    if (!img) return;
    const items = positions(img);
    log('position-observed', { container: event.target === document ? 'window' : event.target.nodeName,
      positions: items });
    if (phase === 'recovering' && needsScroll(items)) queueScroll('position-changed');
  }, { passive: true, capture: true });
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('popstate', checkNavigation);
  window.addEventListener('hashchange', checkNavigation);
  window.addEventListener('pageshow', event => {
    // BFCache restoration keeps the old script/state but represents a new navigation.
    if (event.persisted) startNavigation();
    else {
      checkNavigation();
      // A slow load can delay browser restoration/pageshow until after the initial
      // recovery window. Give this lifecycle boundary one fresh opportunity,
      // but never erase user intent or repeatedly rearm for ordinary scrolls.
      if (!pageShowHandled && phase === 'done') {
        phase = 'waiting';
        recoveryDeadline = null;
        log('lifecycle-rearmed', { reason: 'pageshow' });
      }
    }
    pageShowHandled = true;
    scheduleUpdate();
  });
  window.addEventListener('load', scheduleUpdate);
  setInterval(checkNavigation, NAV_CHECK_MS);

  const observer = new MutationObserver(records => {
    const relevant = records.some(r => {
      if (r.type === 'childList') return true;
      if (r.type !== 'attributes') return false;
      if (r.target === document.body && r.attributeName === 'style' &&
          document.body.style.zoom === lastZoom &&
          document.body.getAttribute('style') === lastZoomStyle) return false;
      return true;
    });
    if (relevant) scheduleUpdate();
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class']
  });
  document.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement) scheduleUpdate();
  }, true);
  startNavigation();
})();
