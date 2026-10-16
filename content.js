// 最大面積の画像を画面の高さに合わせ、ページ遷移時に一度だけ上端へ移動。
(() => {
  'use strict';
  const MIN_AREA = 10000;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 5;
  const SCROLL_SETTLE_MS = 250;
  const SCROLL_DEADLINE_MS = 2500;
  const NAV_CHECK_MS = 350;
  const UPDATE_DEBOUNCE_MS = 100;

  let currentUrl = location.href;
  let navigationId = 0;
  let pendingScroll = true;
  let userScrolled = false;
  let navStart = performance.now();
  let firstCandidateTime = null;
  let lastCandidate = null;
  let lastCandidateArea = 0;
  let updateTimer = null;
  let scrollTimer = null;
  let lastZoom = null;
  let verifyTimer = null;
  let programmaticScroll = false;
  let scrollReleaseTimer = null;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

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
    }
  }

  function scrollToImage(img) {
    programmaticScroll = true;
    img.scrollIntoView({ behavior: 'instant', block: 'start', inline: 'nearest' });
    clearTimeout(scrollReleaseTimer);
    scrollReleaseTimer = setTimeout(() => { programmaticScroll = false; }, 80);
  }

  function performScroll(id) {
    if (id !== navigationId || !pendingScroll || userScrolled) return;
    const { img } = findLargestImage();
    if (!img || !img.isConnected) return;
    applyZoom(img);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (id !== navigationId || !pendingScroll || userScrolled) return;
      const latest = findLargestImage().img;
      if (!latest) return;
      scrollToImage(latest);
      clearTimeout(scrollTimer);
      // サイト側のスクロール位置復元・レイアウト更新に備えて位置を検証する。
      let attempts = 0;
      const verify = () => {
        if (id !== navigationId || userScrolled) { pendingScroll = false; return; }
        const target = findLargestImage().img;
        if (!target) return;
        const top = target.getBoundingClientRect().top;
        // ページ先頭(scrollY=0)でも、画像が下にあるなら再試行する。
        // 内部スクロール領域にもscrollIntoViewで対応する。
        if (Math.abs(top) > 3) {
          scrollToImage(target);
        }
        attempts++;
        if (attempts < 8) verifyTimer = setTimeout(verify, 250);
        else { pendingScroll = false; }
      };
      verifyTimer = setTimeout(verify, 250);
    }));
  }

  function update() {
    const { img, area } = findLargestImage();
    if (!img) return;
    applyZoom(img);
    if (!pendingScroll || userScrolled) return;
    const now = performance.now();
    if (firstCandidateTime === null) firstCandidateTime = now;
    if (img !== lastCandidate || area !== lastCandidateArea) {
      lastCandidate = img;
      lastCandidateArea = area;
    }
    // DOMが更新され続けても期限を延長しない。
    const deadline = navStart + SCROLL_DEADLINE_MS;
    const desired = Math.min(now + SCROLL_SETTLE_MS, deadline);
    clearTimeout(scrollTimer);
    const id = navigationId;
    scrollTimer = setTimeout(() => performScroll(id), Math.max(0, desired - now));
  }

  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(update, UPDATE_DEBOUNCE_MS);
  }

  function startNavigation() {
    currentUrl = location.href;
    navigationId++;
    pendingScroll = true;
    userScrolled = false;
    navStart = performance.now();
    firstCandidateTime = null;
    lastCandidate = null;
    lastCandidateArea = 0;
    clearTimeout(scrollTimer);
    clearTimeout(verifyTimer);
    clearTimeout(scrollReleaseTimer);
    programmaticScroll = false;
    scheduleUpdate();
    // DOMが変化しない遷移でも再試行。
    const id = navigationId;
    for (const delay of [400, 1000, 2000, 3000]) {
      setTimeout(() => { if (id === navigationId && pendingScroll) scheduleUpdate(); }, delay);
    }
  }

  function checkNavigation() {
    if (location.href !== currentUrl) startNavigation();
  }

  // クリック・キー入力では中止しない。明示的なスクロール操作だけを尊重する。
  window.addEventListener('wheel', () => { if (!programmaticScroll) userScrolled = true; }, { passive: true, capture: true });
  window.addEventListener('touchmove', () => { if (!programmaticScroll) userScrolled = true; }, { passive: true, capture: true });
  window.addEventListener('keydown', e => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) {
      if (!programmaticScroll) userScrolled = true;
    }
  }, true);

  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('popstate', checkNavigation);
  window.addEventListener('hashchange', checkNavigation);
  window.addEventListener('pageshow', () => { checkNavigation(); scheduleUpdate(); });
  window.addEventListener('load', scheduleUpdate);
  setInterval(checkNavigation, NAV_CHECK_MS);

  const observer = new MutationObserver(records => {
    // 自分自身によるbodyのzoom更新では再計算しない。
    const relevant = records.some(r => {
      if (r.type === 'childList') return true;
      if (r.type !== 'attributes') return false;
      if (r.target === document.body && r.attributeName === 'style' &&
          document.body.style.zoom === lastZoom) return false;
      return true;
    });
    if (relevant) scheduleUpdate();
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class']
  });
  document.addEventListener('load', e => {
    if (e.target instanceof HTMLImageElement) scheduleUpdate();
  }, true);
  startNavigation();
})();
