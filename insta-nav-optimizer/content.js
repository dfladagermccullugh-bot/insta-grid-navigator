/*
 * Instagram Activity & Grid Optimizer
 * ------------------------------------
 * Vanilla JS content script (Manifest V3). No dependencies, no build step.
 *
 * Five cooperating modules, all wrapped in a single IIFE so nothing leaks to
 * the page's global scope:
 *   1. Bootstrap        - path guard, MutationObserver, SPA navigation hooks
 *   2. Link wrapping    - overlay real <a> tags so native mouse gestures work
 *   3. Scroll memory    - persist/restore scroll position per path
 *   4. Hover tooltips   - surface hidden alt-text metadata on hover
 *   5. Search filter    - live, DOM-only keyword filtering of loaded cells
 *
 * Resilience principle: query by structure (anchor href patterns, img[alt],
 * aspect-ratio containers), never by Instagram's hashed class names. React
 * fiber traversal is a last-resort fallback only.
 */
(function () {
  "use strict";

  // Marker attributes / namespaced keys keep us idempotent and collision-free.
  const PROCESSED_ATTR = "data-igopt";
  const CELL_ATTR = "data-igopt-cell";
  const ALT_ATTR = "data-igopt-alt";
  const SCROLL_KEY_PREFIX = "igopt:scroll:";

  // ----------------------------------------------------------------------------
  // Utilities
  // ----------------------------------------------------------------------------

  /** Are we currently on one of the target grid paths? */
  function isTargetPath() {
    const p = location.pathname;
    return (
      p.startsWith("/your_activity/") ||
      p.startsWith("/saved/") ||
      /^\/[^/]+\/saved\//.test(p)
    );
  }

  /** rAF-based debounce: collapses bursts of mutations into one process pass. */
  function rafDebounce(fn) {
    let scheduled = false;
    return function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        fn();
      });
    };
  }

  /** Time-based throttle for high-frequency events (scroll). */
  function throttle(fn, wait) {
    let last = 0;
    let timer = null;
    return function () {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        last = now;
        fn();
      } else if (!timer) {
        timer = setTimeout(function () {
          last = Date.now();
          timer = null;
          fn();
        }, remaining);
      }
    };
  }

  /**
   * Resolve a post/reel URL for a grid cell.
   * Priority: an existing descendant anchor -> React fiber props -> null.
   */
  function resolvePostUrl(cell) {
    const anchor = cell.querySelector(
      'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
    );
    if (anchor && anchor.getAttribute("href")) {
      return anchor.getAttribute("href");
    }
    return resolveUrlFromFiber(cell);
  }

  /**
   * Fallback: walk React fiber props looking for an href / linkUrl / shortcode.
   * Instagram frequently stores the destination in props even when no <a>
   * exists in the DOM. Bounded depth keeps this cheap.
   */
  function resolveUrlFromFiber(node) {
    const key = Object.keys(node).find(function (k) {
      return (
        k.startsWith("__reactProps$") ||
        k.startsWith("__reactInternalInstance$") ||
        k.startsWith("__reactFiber$")
      );
    });
    if (!key) return null;

    let fiber = node[key];
    let depth = 0;
    while (fiber && depth < 40) {
      const props = fiber.memoizedProps || fiber.pendingProps || fiber;
      if (props && typeof props === "object") {
        const href = props.href || props.linkUrl || props.url;
        if (typeof href === "string" && /\/(p|reel|tv)\//.test(href)) {
          return href;
        }
        if (typeof props.shortcode === "string" && props.shortcode) {
          return "/p/" + props.shortcode + "/";
        }
        const code = props.code || (props.media && props.media.code);
        if (typeof code === "string" && code) {
          return "/p/" + code + "/";
        }
      }
      fiber = fiber.return || fiber.child;
      depth++;
    }
    return null;
  }

  /** Normalize a possibly-relative href into an absolute URL on instagram.com. */
  function absoluteUrl(href) {
    try {
      return new URL(href, location.origin).href;
    } catch (e) {
      return href;
    }
  }

  // ----------------------------------------------------------------------------
  // Module 2: Link wrapping & event interception
  // ----------------------------------------------------------------------------

  /**
   * Find candidate grid cells. We treat the nearest list item / link-sized
   * container that holds an <img> as a "cell". Querying by <img> first keeps
   * us resilient to class-name churn.
   */
  function findGridCells() {
    const imgs = document.querySelectorAll("img:not([" + PROCESSED_ATTR + "])");
    const cells = [];
    imgs.forEach(function (img) {
      const cell = findCellContainer(img);
      if (cell) cells.push({ cell: cell, img: img });
    });
    return cells;
  }

  /**
   * Climb from an <img> to the grid cell container. We prefer an explicit
   * aspect-ratio box (Instagram uses padding-top tricks) or a list item,
   * falling back to a reasonably-sized ancestor.
   */
  function findCellContainer(img) {
    let node = img;
    let depth = 0;
    let fallback = img.parentElement;
    while (node && node !== document.body && depth < 8) {
      const style = node.getAttribute && node.getAttribute("style");
      if (
        node.tagName === "LI" ||
        node.getAttribute("role") === "listitem" ||
        (style && /padding-top/.test(style)) ||
        (style && /aspect-ratio/.test(style))
      ) {
        return node;
      }
      fallback = node;
      node = node.parentElement;
      depth++;
    }
    return fallback;
  }

  /** Wrap a single cell: overlay an anchor, neutralize blocking overlays. */
  function processCell(entry) {
    const cell = entry.cell;
    const img = entry.img;

    // Always mark the image so we don't reconsider it, even if URL resolution
    // fails on this pass.
    img.setAttribute(PROCESSED_ATTR, "1");

    // Cache alt text for tooltips + search (the img may re-render later).
    const alt = (img.getAttribute("alt") || "").trim();
    if (alt) cell.setAttribute(ALT_ATTR, alt);
    cell.setAttribute(CELL_ATTR, "1");

    // Don't double-wrap a cell we've already given an overlay anchor.
    if (cell.querySelector("a.igopt-link")) return;

    const href = resolvePostUrl(cell);
    if (!href) return;

    // Ensure the cell is a positioning context for the absolute overlay.
    const pos = getComputedStyle(cell).position;
    if (pos === "static") {
      cell.style.position = "relative";
    }

    const link = document.createElement("a");
    link.className = "igopt-link";
    link.href = absoluteUrl(href);
    link.target = "_blank";
    link.rel = "noopener";
    link.setAttribute("aria-label", alt || "Open post in new tab");

    // Middle-click: some Instagram handlers swallow auxclick. Re-assert the
    // native "open in background tab" behavior explicitly.
    link.addEventListener("auxclick", function (e) {
      if (e.button === 1) {
        e.stopPropagation();
        window.open(link.href, "_blank");
      }
    });

    cell.appendChild(link);

    // Disarm Meta's invisible click-capturing overlays so gestures reach the
    // anchor. We disable pointer-events on overlay-ish siblings/descendants
    // that sit above the image but carry no useful content of their own.
    neutralizeOverlays(cell, link);
  }

  /**
   * Set pointer-events:none on empty overlay divs that Instagram layers over
   * thumbnails to intercept clicks. We skip the image and our own anchor.
   */
  function neutralizeOverlays(cell, link) {
    const candidates = cell.querySelectorAll("div, span");
    candidates.forEach(function (el) {
      if (el === link || el.contains(link)) return;
      if (el.querySelector("img")) return; // keep containers that hold media
      if (el.textContent && el.textContent.trim().length > 0) return; // keep labels
      // Empty, content-free layer => almost certainly a click shield.
      el.style.pointerEvents = "none";
    });
  }

  // Running total of cells we've wrapped, surfaced in the status badge.
  let processedCount = 0;

  function processAllCells() {
    const cells = findGridCells();
    if (cells.length) {
      const sample = cells[0];
      console.info(
        "[IGOpt] processed",
        cells.length,
        "new grid cell(s); sample url=",
        resolvePostUrl(sample.cell) || "(none)",
        'alt="' + ((sample.img.getAttribute("alt") || "").slice(0, 60)) + '"'
      );
    }
    cells.forEach(processCell);
    processedCount += cells.length;
    updateBadge();
  }

  // ----------------------------------------------------------------------------
  // Status badge — unmissable visual confirmation that the script is live.
  // Positioned inline (not reliant on styles.css) so it shows regardless.
  // ----------------------------------------------------------------------------

  let badgeEl = null;

  function ensureBadge() {
    if (badgeEl && document.body.contains(badgeEl)) return badgeEl;
    badgeEl = document.createElement("div");
    badgeEl.className = "igopt-badge";
    badgeEl.style.cssText =
      "position:fixed;bottom:12px;right:12px;z-index:2147483647;" +
      "padding:4px 8px;border-radius:6px;font:600 11px/1.4 -apple-system," +
      "BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      "background:rgba(0,0,0,0.8);color:#fff;pointer-events:none;" +
      "box-shadow:0 1px 4px rgba(0,0,0,0.4);";
    document.body.appendChild(badgeEl);
    return badgeEl;
  }

  function updateBadge() {
    ensureBadge().textContent = "IGOpt: " + processedCount + " posts";
  }

  // ----------------------------------------------------------------------------
  // Module 4: Hover tooltips (single shared element)
  // ----------------------------------------------------------------------------

  let tooltipEl = null;

  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "igopt-tooltip";
    tooltipEl.style.display = "none";
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function showTooltip(text, x, y) {
    const tip = ensureTooltip();
    tip.textContent = text;
    tip.style.display = "block";

    // Position near the cursor/corner but keep it on screen.
    const margin = 12;
    const rect = tip.getBoundingClientRect();
    let left = x + margin;
    let top = y + margin;
    if (left + rect.width > window.innerWidth) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height > window.innerHeight) {
      top = window.innerHeight - rect.height - margin;
    }
    tip.style.left = Math.max(margin, left) + "px";
    tip.style.top = Math.max(margin, top) + "px";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  // Delegated hover handling: cheap, survives re-renders, no per-cell listeners.
  function initTooltipDelegation() {
    document.addEventListener("mouseover", function (e) {
      const cell = e.target.closest("[" + CELL_ATTR + "]");
      if (!cell) return;
      const alt = cell.getAttribute(ALT_ATTR);
      if (!alt) return;
      showTooltip(alt, e.clientX, e.clientY);
    });

    document.addEventListener("mousemove", function (e) {
      if (!tooltipEl || tooltipEl.style.display === "none") return;
      const cell = e.target.closest("[" + CELL_ATTR + "]");
      if (!cell || !cell.getAttribute(ALT_ATTR)) {
        hideTooltip();
        return;
      }
      showTooltip(cell.getAttribute(ALT_ATTR), e.clientX, e.clientY);
    });

    document.addEventListener("mouseout", function (e) {
      const related = e.relatedTarget;
      if (related && related.closest && related.closest("[" + CELL_ATTR + "]")) {
        return;
      }
      hideTooltip();
    });
  }

  // ----------------------------------------------------------------------------
  // Module 5: Local search filter bar
  // ----------------------------------------------------------------------------

  let searchBar = null;
  let currentQuery = "";

  function ensureSearchBar() {
    if (searchBar && document.body.contains(searchBar)) return searchBar;

    const wrap = document.createElement("div");
    wrap.className = "igopt-searchbar";
    // Critical layout applied inline so the bar is visible even if styles.css
    // somehow fails to load/apply. Theming/colors still come from styles.css.
    wrap.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);" +
      "z-index:2147483646;width:min(420px,90vw);";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "igopt-search-input";
    input.placeholder = "Filter loaded posts by caption / description…";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText =
      "width:100%;box-sizing:border-box;padding:8px 12px;font-size:13px;" +
      "border-radius:8px;outline:none;border:1px solid #888;" +
      "background:#fff;color:#000;box-shadow:0 1px 6px rgba(0,0,0,0.25);";

    input.addEventListener("input", function () {
      currentQuery = input.value.trim().toLowerCase();
      applyFilter();
    });

    wrap.appendChild(input);
    document.body.appendChild(wrap);
    searchBar = wrap;
    console.info(
      "[IGOpt] search bar injected (in DOM:",
      document.body.contains(wrap),
      ")"
    );
    return searchBar;
  }

  /** Show/hide cells based on the current query against cached alt text. */
  function applyFilter() {
    const cells = document.querySelectorAll("[" + CELL_ATTR + "]");
    if (!currentQuery) {
      cells.forEach(function (cell) {
        cell.style.display = "";
      });
      return;
    }
    cells.forEach(function (cell) {
      const alt = (cell.getAttribute(ALT_ATTR) || "").toLowerCase();
      cell.style.display = alt.indexOf(currentQuery) !== -1 ? "" : "none";
    });
  }

  // ----------------------------------------------------------------------------
  // Module 3: Scroll memory
  // ----------------------------------------------------------------------------

  function scrollKey() {
    return SCROLL_KEY_PREFIX + location.pathname;
  }

  /**
   * Instagram's activity / saved grids scroll inside an inner container, NOT the
   * window. Find the nearest scrollable ancestor of a grid cell; fall back to
   * the window scroller if none is found yet (e.g. before cells render).
   */
  function getScroller() {
    const cell = document.querySelector("[" + CELL_ATTR + "]");
    let node = cell ? cell.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      const oy = getComputedStyle(node).overflowY;
      if (
        (oy === "auto" || oy === "scroll") &&
        node.scrollHeight > node.clientHeight + 8
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return window;
  }

  function getScrollTop(scroller) {
    return scroller === window ? window.scrollY || window.pageYOffset : scroller.scrollTop;
  }

  function setScrollTop(scroller, y) {
    if (scroller === window) window.scrollTo({ top: y, behavior: "auto" });
    else scroller.scrollTop = y;
  }

  function saveScroll() {
    if (!isTargetPath()) return;
    try {
      sessionStorage.setItem(scrollKey(), String(getScrollTop(getScroller())));
    } catch (e) {
      /* storage may be unavailable; ignore */
    }
  }

  /**
   * Restore the saved offset. Because the SPA lazy-renders, the container may be
   * too short to scroll to the target immediately. We retry on an interval,
   * growing as content paints, and stop once we're close enough or time out.
   */
  function restoreScroll() {
    if (!isTargetPath()) return;
    let saved;
    try {
      saved = parseInt(sessionStorage.getItem(scrollKey()) || "", 10);
    } catch (e) {
      return;
    }
    if (!saved || isNaN(saved) || saved <= 0) return;

    const start = Date.now();
    const DURATION = 3000;
    const STEP = 150;

    const timer = setInterval(function () {
      const scroller = getScroller();
      setScrollTop(scroller, saved);
      const reached = Math.abs(getScrollTop(scroller) - saved) < 4;
      if (reached || Date.now() - start > DURATION) {
        clearInterval(timer);
      }
    }, STEP);
  }

  function initScrollMemory() {
    // Use capture phase: scroll events on Instagram's inner container do not
    // bubble to window, but they are observable during capture on document.
    document.addEventListener("scroll", throttle(saveScroll, 200), {
      passive: true,
      capture: true,
    });
    // Persist on the way out too (covers in-tab navigation).
    window.addEventListener("beforeunload", saveScroll);
    restoreScroll();
  }

  // ----------------------------------------------------------------------------
  // Module 1: Bootstrap — observer + SPA navigation handling
  // ----------------------------------------------------------------------------

  const schedule = rafDebounce(function () {
    if (!isTargetPath()) return;
    processAllCells();
    // Re-apply an active filter to newly loaded cells.
    if (currentQuery) applyFilter();
  });

  function startObserver() {
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function onNavigation() {
    if (!isTargetPath()) {
      hideTooltip();
      if (searchBar) searchBar.style.display = "none";
      return;
    }
    if (searchBar) searchBar.style.display = "";
    ensureSearchBar();
    schedule();
    restoreScroll();
  }

  /** Patch history methods so we detect SPA route changes. */
  function hookHistory() {
    const fire = function () {
      window.dispatchEvent(new Event("igopt:navigation"));
    };
    ["pushState", "replaceState"].forEach(function (method) {
      const original = history[method];
      history[method] = function () {
        const result = original.apply(this, arguments);
        fire();
        return result;
      };
    });
    window.addEventListener("popstate", fire);
    window.addEventListener("igopt:navigation", onNavigation);
  }

  function init() {
    console.info(
      "[IGOpt] content script loaded on",
      location.pathname,
      "— target page:",
      isTargetPath()
    );

    // These are cheap and globally safe (guarded internally), so install them
    // unconditionally. That way, navigating INTO a target page via Instagram's
    // client-side router still activates every feature.
    initTooltipDelegation();
    initScrollMemory();
    hookHistory();
    startObserver();

    if (isTargetPath()) {
      ensureSearchBar();
      updateBadge();
      schedule();
      // Log the scroll container we'll use (window vs an inner element) once the
      // grid has had a moment to render.
      setTimeout(function () {
        const s = getScroller();
        console.info(
          "[IGOpt] scroll container:",
          s === window ? "window" : s.tagName + "." + (s.className || "")
        );
      }, 1500);
    }
  }

  init();
})();
