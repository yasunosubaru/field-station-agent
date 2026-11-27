// Store kit — behaviours, wired by data attributes. Load once, after the markup (or with `defer`).
//   data-kit-shelf       shelf arrows: shown when the row can scroll that way, one page per click
//   data-kit-gallery     gallery arrows and dots ("compact" puts the dots in a pill)
//   data-kit-sticky      adds .is-stuck while the element is stuck (local bar rule)
//   data-kit-swatches    writes the checked swatch's value into the next .kit-swatches__label
//   data-kit-accordion   toggles aria-expanded on .kit-accordion__button (the CSS animates the panel)
//   data-kit-nav         global nav: flyout menus, search and bag panels, mobile menu (window.KitNav)
//   data-kit-tabs        tab list with arrow keys (window.KitTabs)
//   data-kit-modal-open  opens the <dialog class="kit-modal"> with that id (window.KitModal)
//   data-kit-carousel    autoplay carousel with timed dots and play/pause (window.KitCarousel)
//   data-kit-footer      footer directory collapses into an accordion on narrow footers
//   data-kit-ribbon      promo ribbon: rotates its messages with arrows when there is more than one
//   data-kit-bag         bag page: quantity, remove, line totals, subtotal and total, empty state (window.KitBag)
//   data-kit-stores      store finder: filters the store cards as you type
(() => {
  const chevron = (dir) => `<svg viewBox="0 0 12 20" aria-hidden="true"><path d="${dir === "prev" ? "M10 2L2 10l8 8" : "M2 2l8 8-8 8"}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const arrow = (dir, label) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = `kit-arrow kit-arrow--${dir}`; b.innerHTML = chevron(dir); b.setAttribute("aria-label", label);
    return b;
  };

  // Shelf: one click scrolls by the visible width minus both edges, so the next card lands on the edge.
  document.querySelectorAll("[data-kit-shelf]").forEach((shelf) => {
    const track = shelf.querySelector(".kit-shelf__track");
    if (!track) return;
    const prev = arrow("prev", "Previous"), next = arrow("next", "Next");
    shelf.append(prev, next);
    const page = () => track.clientWidth - 2 * parseFloat(getComputedStyle(track).paddingLeft);
    const update = () => {
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    };
    prev.addEventListener("click", () => track.scrollBy({ left: -page() }));
    next.addEventListener("click", () => track.scrollBy({ left: page() }));
    track.addEventListener("scroll", update, { passive: true });
    new ResizeObserver(update).observe(track);
  });

  // Gallery: the track moves through --slide-x; arrows and dots follow the current slide.
  document.querySelectorAll("[data-kit-gallery]").forEach((gallery) => {
    const track = gallery.querySelector(".kit-gallery__track");
    const slides = [...track.children];
    const prev = arrow("prev", "Previous image"), next = arrow("next", "Next image");
    const dots = document.createElement("div");
    dots.className = "kit-dots" + (gallery.dataset.kitGallery === "compact" ? " kit-dots--pill" : "");
    dots.innerHTML = slides.map((_, i) => `<button type="button" aria-label="Image ${i + 1}"></button>`).join("");
    gallery.append(prev, next, dots);
    let current = 0;
    const go = (i) => {
      current = Math.max(0, Math.min(slides.length - 1, i));
      track.style.setProperty("--slide-x", `${-100 * current}%`);
      prev.disabled = current === 0;
      next.disabled = current === slides.length - 1;
      [...dots.children].forEach((d, k) => d.setAttribute("aria-current", k === current));
    };
    prev.addEventListener("click", () => go(current - 1));
    next.addEventListener("click", () => go(current + 1));
    [...dots.children].forEach((d, k) => d.addEventListener("click", () => go(k)));
    gallery.kitGoTo = go;
    go(0);
  });

  // Sticky: a sentinel just above the element leaves the viewport when the element sticks.
  document.querySelectorAll("[data-kit-sticky]").forEach((el) => {
    const sentinel = document.createElement("div");
    el.before(sentinel);
    new IntersectionObserver(([e]) => el.classList.toggle("is-stuck", !e.isIntersecting)).observe(sentinel);
  });

  // Swatches: the label under the row names the checked colour.
  document.querySelectorAll("[data-kit-swatches]").forEach((row) => {
    const label = row.nextElementSibling?.classList.contains("kit-swatches__label") ? row.nextElementSibling : null;
    const sync = () => { const c = row.querySelector("input:checked"); if (label) label.textContent = c ? c.value : ""; };
    row.addEventListener("change", sync);
    sync();
  });

  // Accordion
  document.querySelectorAll("[data-kit-accordion] .kit-accordion__button").forEach((btn) => {
    btn.addEventListener("click", () => btn.setAttribute("aria-expanded", btn.getAttribute("aria-expanded") !== "true"));
  });
})();

// ===== nav =====
// Store kit — global navigation behaviour. Load after the markup (or with `defer`); needs css/components/nav.css.
//   data-kit-nav   on .kit-nav: hover/focus flyouts, click panels (search, bag), mobile menu, curtain
// Triggers are the elements of the bar carrying aria-controls="<panel id>"; the markup holds the menu content.
//   - top links open their flyout on hover (pointer devices) or focus; ArrowDown moves into the panel, Escape closes
//   - tool buttons (search, bag) open their panel on click, a second click closes it
//   - the burger opens a full-screen list; if no panel of its aria-controls exists, the list is built from the bar links
// API: window.KitNav = { open(nav, panelId), close(nav) }
(() => {
  const STEP = 20, GROUP = 80, LEAVE = 120;   // measured: ms between links, between groups, delay before a hover leave closes
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const items = (panel) => [...panel.querySelectorAll(".kit-nav__title, .kit-nav__group li, .kit-nav__lead, .kit-nav__note")];

  document.querySelectorAll("[data-kit-nav]").forEach((nav) => {
    const frame = nav.querySelector(".kit-nav__frame");
    const bar = nav.querySelector(".kit-nav__bar");
    const flyout = nav.querySelector(".kit-nav__flyout");
    const curtain = nav.querySelector(".kit-nav__curtain");
    const burger = nav.querySelector(".kit-nav__burger");
    const triggers = [...bar.querySelectorAll("[aria-controls]")];
    const panelOf = (t) => document.getElementById(t.getAttribute("aria-controls"));
    // Compact layout = the CSS shows the burger, so the stylesheet stays the only place with the breakpoint.
    const compact = () => !!burger && getComputedStyle(burger).display !== "none";
    let current = null, closeTimer = 0, restoring = false, mode = "click";
    // mode: how the flyout opened (hover | focus | click); restoring: focus returned by close() must not reopen

    // Mobile list: built once from the top-level links of the bar when the author wrote no panel for the burger.
    if (burger && !panelOf(burger)) {
      const panel = document.createElement("div");
      panel.className = "kit-nav__panel"; panel.id = burger.getAttribute("aria-controls") || "kit-nav-menu";
      burger.setAttribute("aria-controls", panel.id);
      const links = [...bar.querySelectorAll(".kit-nav__list .kit-nav__link")];
      panel.innerHTML = `<div class="kit-nav__group"><ul class="kit-nav__menu-list">${links.map((a) => `<li><a href="${a.getAttribute("href") || "#"}">${a.textContent}</a></li>`).join("")}</ul></div>`;
      flyout.append(panel);
    }
    const panels = [...flyout.querySelectorAll(".kit-nav__panel")];
    const burgerLines = burger?.querySelector("svg");
    if (burgerLines && !burgerLines.querySelector(".kit-nav__bread-top")) {
      const l = burgerLines.querySelectorAll("line");
      l[0]?.classList.add("kit-nav__bread-top"); l[1]?.classList.add("kit-nav__bread-bottom");
    }

    // Stagger: a link waits (index * STEP + (group + 1) * GROUP); a group title waits (group + 1) * GROUP.
    // The way out is quicker for items near the end of the list.
    const stagger = (panel) => {
      const all = items(panel), groups = [...panel.querySelectorAll(".kit-nav__group")];
      all.forEach((el, n) => {
        const grp = el.closest(".kit-nav__group"), g = Math.max(0, groups.indexOf(grp));
        const list = el.closest("ul");
        const i = el.matches(".kit-nav__title") ? -1 : list ? [...list.children].indexOf(el) : n;
        el.style.setProperty("--d", (i < 0 ? g * GROUP + GROUP : i * STEP + (g + 1) * GROUP) + "ms");
        el.style.setProperty("--out", Math.min(160 + STEP * (all.length - n), 240) + "ms");
      });
    };

    const open = (id, trigger, how = "click") => {
      const panel = panels.find((p) => p.id === id);
      if (!panel) return;
      clearTimeout(closeTimer);
      const switching = current !== null && current !== id;
      panels.forEach((p) => p.classList.toggle("is-current", p === panel));
      stagger(panel);
      triggers.forEach((t) => t.setAttribute("aria-expanded", String(t === trigger)));
      const menu = !!burger && trigger === burger;
      nav.classList.toggle("is-menu", menu);
      nav.classList.add("is-open");
      nav.classList.toggle("is-switching", switching && !reduce.matches);
      // Open height = panel + bar, capped to the window; the full window in the compact layout.
      const h = compact() ? innerHeight : Math.min(panel.offsetHeight + bar.offsetHeight, innerHeight - 2 * bar.offsetHeight);
      flyout.style.setProperty("--flyout-h", h + "px");
      nav.classList.toggle("has-curtain", !compact());
      if (menu) document.documentElement.style.overflow = "hidden";
      if (switching) setTimeout(() => nav.classList.remove("is-switching"), 420);
      current = id; mode = how;
      if (panel.querySelector("input")) setTimeout(() => panel.querySelector("input").focus(), 240);
    };
    const close = (restoreFocus) => {
      if (current === null) return;
      clearTimeout(closeTimer);
      const t = triggers.find((x) => x.getAttribute("aria-expanded") === "true");
      nav.classList.remove("is-open", "is-menu", "is-switching", "has-curtain");
      flyout.style.removeProperty("--flyout-h");
      triggers.forEach((x) => x.setAttribute("aria-expanded", "false"));
      document.documentElement.style.overflow = "";
      current = null;
      if (restoreFocus && t) { restoring = true; t.focus(); restoring = false; }
    };
    const closeSoon = () => { clearTimeout(closeTimer); closeTimer = setTimeout(close, LEAVE); };

    triggers.forEach((t) => {
      t.setAttribute("aria-expanded", "false");
      const id = t.getAttribute("aria-controls");
      const isLink = t.classList.contains("kit-nav__link");
      if (isLink) {
        // Flyouts of the top links: hover on pointer devices, focus for the keyboard.
        t.addEventListener("mouseenter", () => { if (!compact() && matchMedia("(hover: hover)").matches) open(id, t, "hover"); });
        t.addEventListener("focus", () => { if (!restoring && !compact() && t.matches(":focus-visible")) open(id, t, "focus"); });
        t.addEventListener("keydown", (e) => {
          if (e.key === "ArrowDown" && current === id) { e.preventDefault(); panelOf(t).querySelector("a")?.focus(); }
        });
      } else {
        t.addEventListener("click", (e) => { e.preventDefault(); current === id ? close() : open(id, t); });
      }
    });
    // Hovering the logo or leaving the bar closes a hover flyout, not a click panel.
    const clickPanel = () => mode !== "hover";   // only a hover flyout closes when the pointer leaves
    nav.addEventListener("mouseleave", () => { if (current !== null && !clickPanel()) closeSoon(); });
    nav.addEventListener("mouseenter", () => clearTimeout(closeTimer));
    bar.querySelector(".kit-nav__logo")?.addEventListener("mouseenter", () => { if (current !== null && !clickPanel()) closeSoon(); });

    // Inside the panel: arrows move between links, Escape returns to the trigger, leaving the nav with Tab closes.
    flyout.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const links = [...flyout.querySelector(".kit-nav__panel.is-current").querySelectorAll("a")];
      const k = links.indexOf(document.activeElement);
      if (k < 0) return;
      e.preventDefault();
      if (e.key === "ArrowUp" && k === 0) return close(true);
      links[Math.max(0, Math.min(links.length - 1, k + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    });
    nav.addEventListener("focusout", (e) => { if (current !== null && !compact() && e.relatedTarget && !nav.contains(e.relatedTarget)) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(true); });
    curtain?.addEventListener("click", () => close());
    // The curtain sits inside the nav element, so entering it counts as staying in the nav: treat it as leaving.
    curtain?.addEventListener("mouseenter", () => { if (current !== null && !clickPanel()) closeSoon(); });
    document.addEventListener("click", (e) => { if (current !== null && !nav.contains(e.target)) close(); });
    let wasCompact = compact();
    addEventListener("resize", () => { if (compact() !== wasCompact) { wasCompact = compact(); close(); } });

    // Bag badge: window.KitNav.badge(nav, n) shows the item count.
    nav.kitOpen = open; nav.kitClose = close;
  });

  window.KitNav = {
    open: (nav, id) => nav.kitOpen?.(id, nav.querySelector(`[aria-controls="${id}"]`)),
    close: (nav) => nav.kitClose?.(),
    badge: (nav, n) => { const b = nav.querySelector(".kit-nav__badge"); if (!b) return; b.textContent = n || ""; b.classList.toggle("has-count", n > 0); },
  };
})();

// ===== tabs =====
// Store kit — tabs behaviour. No dependency.
//   data-kit-tabs   on the role="tablist" element: click or arrow keys (Left/Right, Home/End) select a tab,
//                   set aria-selected and a roving tabindex, and show the panel named by aria-controls.
// Optional API: KitTabs.select(tabElement).
(() => {
  const select = (tab) => {
    const tabs = [...tab.closest("[role=tablist]").querySelectorAll('[role="tab"]')];
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  document.querySelectorAll("[data-kit-tabs]").forEach((list) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", (e) => {
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        const next = tabs[(to + tabs.length) % tabs.length];
        next.focus();
        select(next);
      });
    });
    select(tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0]);
  });

  window.KitTabs = { select };
})();

// ===== modal =====
// Store kit — modal behaviour for <dialog class="kit-modal">. No dependency.
//   data-kit-modal-open="id"   on any element: opens the dialog with that id (showModal)
// A click on the dialog itself (outside its panel, i.e. on the scrim) closes it. Escape, the focus trap, focus
// return to the opener and the inert page come from the native dialog. Optional API: KitModal.open(el) / .close(el).
(() => {
  const open = (d) => { if (d && !d.open) d.showModal(); };
  const close = (d) => { if (d && d.open) d.close(); };

  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-kit-modal-open]");
    if (opener) {
      const d = document.getElementById(opener.dataset.kitModalOpen);
      if (d) { e.preventDefault(); open(d); }
      return;
    }
    // The dialog fills the viewport, so a click that lands on it directly is a click on the scrim.
    if (e.target instanceof HTMLDialogElement && e.target.classList.contains("kit-modal")) close(e.target);
  });

  window.KitModal = { open, close };
})();

// ===== carousel =====
// Store kit — autoplay carousel with a timed dotnav.
//   data-kit-carousel   on .kit-carousel: builds the dots and the play/pause button, advances when the current dot has
//                       filled, pauses on hover/focus and when off screen, starts paused with prefers-reduced-motion.
// API: window.KitCarousel.init(root) wires a carousel added later; root.kitCarousel = { go(n), play(), pause(), index }.
(() => {
  const PAUSE = '<svg class="i-pause" viewBox="0 0 18 18" aria-hidden="true"><rect x="4" y="3" width="3.4" height="12" rx="1.2" fill="currentColor"/><rect x="10.6" y="3" width="3.4" height="12" rx="1.2" fill="currentColor"/></svg>';
  const PLAY = '<svg class="i-play" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 3.2v11.6c0 .7.8 1.1 1.4.7l8.4-5.8a.85.85 0 0 0 0-1.4L6.4 2.5C5.8 2.1 5 2.5 5 3.2z" fill="currentColor"/></svg>';

  const init = (root) => {
    if (root.kitCarousel) return root.kitCarousel;
    const track = root.querySelector(".kit-carousel__track");
    const slides = [...track.children];
    const ctrls = document.createElement("div");
    ctrls.className = "kit-carousel__controls";
    ctrls.innerHTML = `<div class="kit-carousel__bubble"><div class="kit-carousel__dots">${slides.map((_, i) => `<button type="button" style="--i:${i}" aria-label="Slide ${i + 1}"></button>`).join("")}</div></div>
      <button type="button" class="kit-carousel__play" aria-label="Pause">${PAUSE}${PLAY}</button>`;
    root.append(ctrls);
    const dots = [...ctrls.querySelectorAll(".kit-carousel__dots button")];
    const play = ctrls.querySelector(".kit-carousel__play");
    root.setAttribute("aria-roledescription", "carousel");
    slides.forEach((s, k) => { s.setAttribute("role", "group"); s.setAttribute("aria-roledescription", "slide"); s.setAttribute("aria-label", `${k + 1} of ${slides.length}`); });

    let current = 0;
    const go = (n) => {
      if (ctrls.classList.contains("is-in") && n !== 0) ctrls.classList.add("is-running");
      current = (n + slides.length) % slides.length;
      track.style.setProperty("--slide-x", `${-100 * current}%`);
      slides.forEach((s, k) => { s.inert = k !== current; });
      dots.forEach((d, k) => {
        d.setAttribute("aria-current", k === current);
      });
    };
    const setPaused = (paused) => {
      root.classList.toggle("is-paused", paused);
      play.setAttribute("aria-label", paused ? "Play" : "Pause");
    };

    dots.forEach((d, k) => d.addEventListener("click", () => go(k)));
    // The dash reaching its end is the timer: advance unless the user paused.
    dots.forEach((d) => d.addEventListener("animationend", (e) => { if (e.animationName === "kit-carousel-fill" && e.elapsedTime > 0 && !root.classList.contains("is-paused")) go(current + 1); }));
    ctrls.querySelector(".kit-carousel__dots").addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault(); go(current + step); dots[current].focus();
    });
    play.addEventListener("click", () => setPaused(!root.classList.contains("is-paused")));

    // Hover, keyboard focus and being off screen hold the timer without touching the user's choice.
    let hover = false, focus = false, visible = true;
    const hold = () => root.classList.toggle("is-held", hover || focus || !visible);
    root.addEventListener("pointerenter", () => { hover = true; hold(); });
    root.addEventListener("pointerleave", () => { hover = false; hold(); });
    root.addEventListener("focusin", () => { focus = true; hold(); });
    root.addEventListener("focusout", () => { focus = false; hold(); });

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setPaused(true);

    // The controls make their entrance once the carousel is mostly in view; leaving the screen holds the timer.
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting; hold();
      if (e.intersectionRatio >= .4 || e.intersectionRect.height >= innerHeight * .4) ctrls.classList.add("is-in");
    }, { threshold: [0, .4] }).observe(root);
    go(0);

    return (root.kitCarousel = { go, play: () => setPaused(false), pause: () => setPaused(true), get index() { return current; } });
  };

  document.querySelectorAll("[data-kit-carousel]").forEach(init);
  window.KitCarousel = { init };
})();

// ===== footer =====
// Store kit — footer behaviour. Link after kit.js (or alone); no dependency.
//   data-kit-footer   on .kit-footer: below 735 px of footer width the directory titles toggle aria-expanded on
//                     click (the CSS shows or hides the list); on wider footers aria-expanded is removed because
//                     the lists are always visible.
(() => {
  document.querySelectorAll("[data-kit-footer]").forEach((footer) => {
    const titles = [...footer.querySelectorAll(".kit-footer__title")];
    let compact = null;
    const sync = (isCompact) => {
      if (isCompact === compact) return;
      compact = isCompact;
      titles.forEach((t) => (compact ? t.setAttribute("aria-expanded", "false") : t.removeAttribute("aria-expanded")));
    };
    titles.forEach((t) => t.addEventListener("click", () => {
      if (compact) t.setAttribute("aria-expanded", t.getAttribute("aria-expanded") !== "true");
    }));
    new ResizeObserver(([e]) => sync(e.contentRect.width <= 734)).observe(footer);
  });
})();

// ===== ribbon =====
// data-kit-ribbon: the first .kit-ribbon__msg is current; with several messages, arrows step through them.
(() => {
  const chevron = (d) => `<svg viewBox="0 0 10 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  document.querySelectorAll("[data-kit-ribbon]").forEach((ribbon) => {
    const msgs = [...ribbon.querySelectorAll(".kit-ribbon__msg")];
    if (!msgs.length) return;
    let i = 0;
    msgs[0].classList.add("is-current");
    ribbon.setAttribute("data-kit-ready", "");
    if (msgs.length < 2) return;
    const show = (n) => { msgs[i].classList.remove("is-current"); i = (n + msgs.length) % msgs.length; msgs[i].classList.add("is-current"); };
    const inner = ribbon.querySelector(".kit-ribbon__inner") || ribbon;
    [["prev", "Previous", "M8 1L2 8l6 7", -1], ["next", "Next", "M2 1l6 7-6 7", 1]].forEach(([side, label, d, step]) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = `kit-ribbon__arrow kit-ribbon__arrow--${side}`; b.setAttribute("aria-label", label);
      b.innerHTML = chevron(d);
      b.addEventListener("click", () => show(i + step));
      inner.append(b);
    });
  });
})();

// ===== bag =====
// data-kit-bag: each .kit-bag__line carries data-price; a [data-kit-bag-qty] select sets its quantity and
// [data-kit-bag-remove] removes it. Totals are written into [data-kit-bag-line], [data-kit-bag-subtotal] and
// [data-kit-bag-total], formatted with data-currency (default USD) and the page language. When no line is left,
// data-state="empty" shows the empty part. Fires "kit-bag:change" with { count, total } on every change.
(() => {
  const init = (bag) => {
    const money = new Intl.NumberFormat(document.documentElement.lang || "en-US", { style: "currency", currency: bag.dataset.currency || "USD" });
    const update = () => {
      const lines = [...bag.querySelectorAll(".kit-bag__line")];
      let total = 0, count = 0;
      lines.forEach((line) => {
        const qty = Number(line.querySelector("[data-kit-bag-qty]")?.value || 1);
        const sum = Number(line.dataset.price || 0) * qty;
        total += sum; count += qty;
        const out = line.querySelector("[data-kit-bag-line]");
        if (out) out.textContent = money.format(sum);
      });
      bag.querySelectorAll("[data-kit-bag-subtotal], [data-kit-bag-total]").forEach((el) => (el.textContent = money.format(total)));
      bag.dataset.state = lines.length ? "full" : "empty";
      bag.dispatchEvent(new CustomEvent("kit-bag:change", { bubbles: true, detail: { count, total } }));
    };
    bag.addEventListener("change", (e) => { if (e.target.matches("[data-kit-bag-qty]")) update(); });
    bag.addEventListener("click", (e) => {
      const remove = e.target.closest("[data-kit-bag-remove]");
      if (!remove) return;
      remove.closest(".kit-bag__line")?.remove();
      update();
    });
    update();
  };
  document.querySelectorAll("[data-kit-bag]").forEach(init);
  window.KitBag = { init };
})();

// ===== stores =====
// data-kit-stores: typing in the search input hides the .kit-store cards whose text (plus data-search) does not
// contain every typed word, and shows .kit-stores__none when nothing is left.
(() => {
  const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  document.querySelectorAll("[data-kit-stores]").forEach((root) => {
    const input = root.querySelector('input[type="search"]');
    const stores = [...root.querySelectorAll(".kit-store")];
    const none = root.querySelector(".kit-stores__none");
    if (!input) return;
    const text = new Map(stores.map((s) => [s, norm(s.textContent + " " + (s.dataset.search || ""))]));
    input.addEventListener("input", () => {
      const words = norm(input.value).split(/\s+/).filter(Boolean);
      let shown = 0;
      stores.forEach((s) => { const hit = words.every((w) => text.get(s).includes(w)); s.hidden = !hit; shown += hit; });
      if (none) none.hidden = shown > 0;
      // The shelf arrows depend on the row width: let them recompute.
      root.querySelector(".kit-shelf__track")?.dispatchEvent(new Event("scroll"));
    });
  });
})();
