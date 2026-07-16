// resort-booking.js
//
// Standalone live-booking widget for /resort/<slug> pages.
// Reads window.__RESORT_BOOKING__ (set inline by the SEO generator) for
// resort_id / resort_name / country, plus the inline wizard's form values.
// Orchestrates the full server pipeline without sending the user back to /:
//
//   Search ──▶ poll get_packages until this resort's package exists
//          ──▶ start_pricing(search_id) fire-and-forget
//          ──▶ poll until the package has hotel_price + flight_price
//          ──▶ get_hotel_offers + get_flight_offers in parallel
//          ──▶ render rooms + flights inline; user picks one of each
//          ──▶ generate_booking_redirect on book click
//
// All the existing edge functions are reused as-is — no backend changes.

(function () {
  "use strict";

  const cfg = window.__RESORT_BOOKING__ || {};
  const RESORT_ID = cfg.resort_id;
  const RESORT_NAME = cfg.resort_name || "this resort";
  const COUNTRY = cfg.country || null;
  const SUPABASE_URL = "https://wyqbtcuoorclmirepkuo.supabase.co";
  const ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5cWJ0Y3Vvb3JjbG1pcmVwa3VvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3MzQ0MDMsImV4cCI6MjA4NjMxMDQwM30.LfZX0hMgJJQ5f-euBE4nRZnPQ4Kpc7IN3c1t9ht4Zbc";

  if (!RESORT_ID) return;

  // Same session-id + internal-traffic contract the homepage uses (see
  // index.html). Read directly from localStorage so the resort page
  // works standalone — and honour /?internal=1 / /?internal=0 here too
  // so visitors who land on a resort page first can self-tag.
  const SESSION_ID = (function () {
    try {
      let id = localStorage.getItem("kt_session_id");
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) ||
          (Date.now().toString(36) + Math.random().toString(36).slice(2));
        localStorage.setItem("kt_session_id", id);
      }
      return id;
    } catch { return null; }
  })();
  const IS_INTERNAL = (function () {
    try {
      const qp = new URLSearchParams(location.search);
      if (qp.get("internal") === "1") localStorage.setItem("kt_internal", "1");
      else if (qp.get("internal") === "0") localStorage.removeItem("kt_internal");
      return localStorage.getItem("kt_internal") === "1";
    } catch { return false; }
  })();
  // Expose for any other widget that might want them (e.g. the SEO
  // wizard-only on country pages, if we later add the same flow there).
  window.KT_SESSION_ID = SESSION_ID;
  window.KT_IS_INTERNAL = IS_INTERNAL;

  // Fire-and-forget funnel event to the log_event edge fn. Never throws.
  function logEvent(signal_type, payload) {
    try {
      // Mirror to GA4 (same mapping as the homepage trackEvent) so resort-page
      // booking clicks land in the same funnel/conversion reports. gtag is
      // present only if the page loaded the tag (see SEO page <head>).
      if (typeof gtag === "function") {
        const GA_NAME = {
          booking_click: "begin_checkout",   // primary conversion
          watch_trip_click: "generate_lead",
        }[signal_type] || signal_type;
        gtag("event", GA_NAME, {
          ...(payload || {}),
          session_id: SESSION_ID,
          internal_traffic: IS_INTERNAL ? "yes" : "no",
        });
      }
      fetch(`${SUPABASE_URL}/functions/v1/log_event`, {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
        body: JSON.stringify({ signal_type, session_id: SESSION_ID, is_internal: IS_INTERNAL, payload: payload || null }),
      }).catch(() => {});
    } catch (_) { /* analytics must never break the page */ }
  }

  // ---- DOM helpers ------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) =>
    n == null || !Number.isFinite(Number(n))
      ? "—"
      : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const fmtMin = (m) => {
    const x = Number(m);
    if (!Number.isFinite(x) || x <= 0) return "—";
    return `${Math.floor(x / 60)}h ${x % 60}m`;
  };

  // ---- API helper -------------------------------------------------------
  async function callFn(path, init) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ANON_KEY}`,
        apikey: ANON_KEY,
        ...((init && init.headers) || {}),
      },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  // ---- State ------------------------------------------------------------
  const state = {
    package_id: null,
    search_id: null,
    rooms: [],
    flights: [],
    selectedRoomId: null,
    selectedFlightId: null,
    party: null, // { adults, kid_ages, total }
  };

  // ---- Render helpers ---------------------------------------------------
  function setStatus(text, kind) {
    const el = $("rb-status");
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "rb-status" + (kind ? ` rb-status-${kind}` : "");
  }

  function ensureResultsHost() {
    let host = $("rb-results");
    if (host) return host;
    host = document.createElement("section");
    host.id = "rb-results";
    host.className = "rb-results";
    host.innerHTML = `
      <div id="rb-status" class="rb-status" hidden></div>
      <div id="rb-rooms-block" hidden>
        <h2 class="rb-h2">Rooms available for your dates</h2>
        <p class="rb-sub" id="rb-rooms-sub"></p>
        <ul class="rb-list" id="rb-rooms-list"></ul>
      </div>
      <div id="rb-flights-block" hidden>
        <h2 class="rb-h2">Flight options</h2>
        <p class="rb-sub" id="rb-flights-sub"></p>
        <div class="rb-flight-tabs" id="rb-flight-tabs">
          <button type="button" class="rb-flight-tab is-active" data-sort="best">Best</button>
          <button type="button" class="rb-flight-tab" data-sort="cheapest">Cheapest</button>
          <button type="button" class="rb-flight-tab" data-sort="fastest">Fastest</button>
        </div>
        <ul class="rb-list" id="rb-flights-list"></ul>
      </div>
      <div id="rb-book-bar" class="rb-book-bar" hidden>
        <div class="rb-book-summary">
          <div class="rb-book-total"><span id="rb-total">—</span><small id="rb-total-sub">flights + hotel</small></div>
          <div class="rb-book-split" id="rb-split"></div>
        </div>
        <div class="rb-book-actions">
          <button type="button" class="rb-book-btn rb-book-btn-secondary" id="rb-book-flight">Book flight →</button>
          <button type="button" class="rb-book-btn rb-book-btn-primary" id="rb-book-hotel">Book hotel →</button>
        </div>
      </div>
    `;
    // Insert immediately after the wizard card on the resort page.
    const wiz = document.querySelector(".seo-wizard");
    if (wiz && wiz.parentNode) wiz.parentNode.insertBefore(host, wiz.nextSibling);
    else document.querySelector(".seo-main .seo-wrap")?.appendChild(host);
    return host;
  }

  function renderRooms() {
    const block = $("rb-rooms-block");
    const list = $("rb-rooms-list");
    const sub = $("rb-rooms-sub");
    if (!block || !list) return;
    if (!state.rooms.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    if (sub) sub.textContent = `${state.rooms.length} room${state.rooms.length === 1 ? "" : "s"} sleeping at least ${state.party?.total ?? "your party"}.`;
    list.innerHTML = state.rooms.map((o) => {
      const sel = state.selectedRoomId === o.offer_id ? " is-selected" : "";
      const name = o.room_name || o.name || o.matched_room_name || "Room";
      const occ = Number(o.max_occupancy) || null;
      const beds = o.bed_summary || (Array.isArray(o.bed_types) ? o.bed_types.map((b) => `${b.quantity || 1}× ${b.bedType || b.type || "bed"}`).join(" + ") : "");
      const meta = [
        occ ? `Sleeps ${occ}` : null,
        beds || null,
        o.board_basis || o.meal_plan || null,
        o.refundable === true ? "Free cancellation" : (o.refundable === false ? "Non-refundable" : null),
      ].filter(Boolean).join(" · ");
      return `<li class="rb-card rb-card-room${sel}" data-offer-id="${esc(o.offer_id)}">
        <div class="rb-card-body">
          <div class="rb-card-title">${esc(name)}</div>
          ${meta ? `<div class="rb-card-meta">${esc(meta)}</div>` : ""}
        </div>
        <div class="rb-card-price">
          <div class="rb-price">${money(o.total_price ?? o.price_min)}</div>
          <div class="rb-price-sub">total for stay</div>
          <button type="button" class="rb-select-btn" data-action="select-room" data-offer-id="${esc(o.offer_id)}">${sel ? "Selected ✓" : "Select"}</button>
        </div>
      </li>`;
    }).join("");
  }

  function renderFlights(sort) {
    const block = $("rb-flights-block");
    const list = $("rb-flights-list");
    const sub = $("rb-flights-sub");
    if (!block || !list) return;
    if (!state.flights.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    const sorted = sortFlights(state.flights, sort || "best");
    if (sub) sub.textContent = `${state.flights.length} live fare${state.flights.length === 1 ? "" : "s"} for your dates.`;
    list.innerHTML = sorted.map((o) => {
      const sel = state.selectedFlightId === o.offer_id ? " is-selected" : "";
      const dur = fmtMin(o.total_duration_minutes);
      const stops = (Number(o.outbound_stops ?? 0)) + (Number(o.return_stops ?? 0));
      const stopsTxt = stops === 0 ? "Direct both ways" : `${stops} stop${stops === 1 ? "" : "s"} round-trip`;
      const airline = o.outbound_carrier_name || o.airline_name || o.outbound_carrier_code || "";
      return `<li class="rb-card rb-card-flight${sel}" data-offer-id="${esc(o.offer_id)}">
        <div class="rb-card-body">
          <div class="rb-card-title">${esc(airline || "Flight")}</div>
          <div class="rb-card-meta">${esc(`${dur} · ${stopsTxt}`)}</div>
        </div>
        <div class="rb-card-price">
          <div class="rb-price">${money(o.total_price)}</div>
          <div class="rb-price-sub">round-trip total</div>
          <button type="button" class="rb-select-btn" data-action="select-flight" data-offer-id="${esc(o.offer_id)}">${sel ? "Selected ✓" : "Select"}</button>
        </div>
      </li>`;
    }).join("");
  }

  function sortFlights(list, sort) {
    if (sort === "cheapest") return [...list].sort((a, b) => Number(a.total_price ?? 0) - Number(b.total_price ?? 0));
    if (sort === "fastest") return [...list].sort((a, b) => Number(a.total_duration_minutes ?? 9e9) - Number(b.total_duration_minutes ?? 9e9));
    // "best": cheapest + travel-time + stop penalty
    return [...list].sort((a, b) => {
      const score = (o) =>
        Number(o.total_price ?? 0) +
        (Number(o.total_duration_minutes ?? 0) / 60) * 20 +
        (Number(o.outbound_stops ?? 0) + Number(o.return_stops ?? 0)) * 80;
      return score(a) - score(b);
    });
  }

  function renderBookBar() {
    const bar = $("rb-book-bar");
    if (!bar) return;
    const haveAny = state.rooms.length || state.flights.length;
    if (!haveAny) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const room = state.rooms.find((r) => r.offer_id === state.selectedRoomId) || state.rooms[0];
    const flight = state.flights.find((f) => f.offer_id === state.selectedFlightId) || sortFlights(state.flights, "best")[0];
    const roomPrice = Number(room?.total_price ?? room?.price_min ?? 0);
    const flightPrice = Number(flight?.total_price ?? 0);
    const total = roomPrice + flightPrice;
    const totalEl = $("rb-total");
    if (totalEl) totalEl.textContent = money(total > 0 ? total : null);
    const subEl = $("rb-total-sub");
    if (subEl) {
      const n = state.party?.total ?? 0;
      subEl.textContent = `flights + hotel · ${n} guest${n === 1 ? "" : "s"}`;
    }
    const split = $("rb-split");
    if (split) {
      split.textContent =
        (flightPrice > 0 ? `${money(flightPrice)} flights` : "") +
        (flightPrice > 0 && roomPrice > 0 ? " · " : "") +
        (roomPrice > 0 ? `${money(roomPrice)} hotel` : "");
    }
    $("rb-book-hotel").disabled = !room;
    $("rb-book-flight").disabled = !flight || !(flight.deep_link || flight.booking_url || flight.book_url);
  }

  function rerender() {
    renderRooms();
    renderFlights("best");
    renderBookBar();
  }

  // ---- Pipeline ---------------------------------------------------------
  function partyFromForm(form) {
    const adults = parseInt(form.elements.adults?.value ?? "2", 10) || 2;
    const kidsRaw = String(form.elements.kids?.value ?? "");
    const kid_ages = kidsRaw
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 17);
    return { adults, kid_ages, total: adults + kid_ages.length };
  }

  async function pollForPackage(search_id, deadlineMs) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      const data = await callFn(`get_packages?search_id=${search_id}&limit=1000`, { method: "GET" });
      const pkg = (data.packages || []).find((p) => p.resort_id === RESORT_ID);
      if (pkg) return pkg;
      await sleep(1500);
    }
    return null;
  }

  async function pollUntilPriced(search_id, package_id, deadlineMs) {
    const start = Date.now();
    let lastPkg = null;
    while (Date.now() - start < deadlineMs) {
      const data = await callFn(
        `get_packages?search_id=${search_id}&limit=1000&only_priced=true`,
        { method: "GET" });
      const pkg = (data.packages || []).find((p) => p.package_id === package_id);
      if (pkg) {
        lastPkg = pkg;
        // The hard requirement is hotel_price + full-leg flight basis. We
        // intentionally allow flight_price_basis === null (combined-fare
        // legacy) since those have valid totals, but reject "oneway_outbound"
        // (matches the homepage's pending logic added earlier today).
        if (pkg.hotel_price != null && pkg.total_price != null &&
            pkg.flight_price_basis !== "oneway_outbound") {
          return pkg;
        }
      }
      await sleep(1500);
    }
    return lastPkg;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runFlow(formValues) {
    const { origin, date_start, date_end, party } = formValues;
    state.party = party;

    setStatus("Searching for trips…", "loading");
    ensureResultsHost();

    // 1. Search
    const search = await callFn("Search", {
      method: "POST",
      body: JSON.stringify({
        origin_iata: origin,
        date_start,
        date_end,
        adults: party.adults,
        child_ages: party.kid_ages,
        require_all_inclusive: false,
        require_kids_club: false,
        // Server-side scope — saves the worker from pricing 974 properties.
        included_countries: COUNTRY ? [COUNTRY] : [],
        session_id: SESSION_ID,
        is_internal: IS_INTERNAL,
      }),
    });
    state.search_id = search.search_id;
    if (!state.search_id) throw new Error("Search did not return a search_id");

    // 2. Poll for this resort's package to appear
    setStatus("Found your search — locating " + RESORT_NAME + "…", "loading");
    const pkg = await pollForPackage(state.search_id, 30000);
    if (!pkg) throw new Error(
      `${RESORT_NAME} isn't included in this search — likely no flight route from ${origin} to ${COUNTRY || "this destination"} for your dates.`);
    state.package_id = pkg.package_id;

    // 3. Pricing
    setStatus("Pricing live rooms and flights…", "loading");
    callFn("start_pricing", {
      method: "POST",
      body: JSON.stringify({ search_id: state.search_id }),
    }).catch((e) => console.error("start_pricing failed:", e));

    // 4. Wait until this package has prices
    const priced = await pollUntilPriced(state.search_id, state.package_id, 75000);
    if (!priced) {
      setStatus("Live rates still warming up. Refresh in a moment, or try slightly different dates.", "warn");
      return;
    }

    // 5. Fetch rooms + flights in parallel
    setStatus("Loading live availability…", "loading");
    const [roomsRes, flightsRes] = await Promise.allSettled([
      callFn(`get_hotel_offers?package_id=${encodeURIComponent(state.package_id)}&limit=20`, { method: "GET" }),
      callFn(`get_flight_offers?package_id=${encodeURIComponent(state.package_id)}&limit=15`, { method: "GET" }),
    ]);

    if (roomsRes.status === "fulfilled") {
      const offers = Array.isArray(roomsRes.value?.offers) ? roomsRes.value.offers : [];
      // Strict fit on max_occupancy >= party total (matches the homepage logic).
      state.rooms = offers.filter((o) => {
        const m = Number(o.max_occupancy);
        return !Number.isFinite(m) || m >= party.total;
      });
      if (state.rooms.length && !state.selectedRoomId) {
        // Default pick: cheapest fitting room.
        const sorted = [...state.rooms].sort((a, b) => Number(a.total_price ?? a.price_min ?? 0) - Number(b.total_price ?? b.price_min ?? 0));
        state.selectedRoomId = sorted[0]?.offer_id || null;
      }
    } else {
      console.error("rooms fetch failed:", roomsRes.reason);
    }

    if (flightsRes.status === "fulfilled") {
      state.flights = Array.isArray(flightsRes.value?.offers) ? flightsRes.value.offers : [];
      if (state.flights.length && !state.selectedFlightId) {
        const best = sortFlights(state.flights, "best")[0];
        state.selectedFlightId = best?.offer_id || null;
      }
    } else {
      console.error("flights fetch failed:", flightsRes.reason);
    }

    rerender();
    if (!state.rooms.length && !state.flights.length) {
      setStatus("Live rates aren't available for these dates. Try widening the date range.", "warn");
    } else if (!state.rooms.length) {
      setStatus("Flights priced live; the hotel partner hasn't returned rates for these exact dates yet. Try a one-day shift.", "warn");
    } else if (!state.flights.length) {
      setStatus("Hotel rooms priced live; no flights returned yet for this origin/dates pairing.", "warn");
    } else {
      setStatus("");
    }
  }

  // ---- Click handlers ---------------------------------------------------
  function bindEvents() {
    document.addEventListener("click", async (e) => {
      const tab = e.target.closest && e.target.closest(".rb-flight-tab");
      if (tab) {
        document.querySelectorAll(".rb-flight-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
        renderFlights(tab.dataset.sort);
        return;
      }
      const sel = e.target.closest && e.target.closest("[data-action]");
      if (sel) {
        const action = sel.dataset.action;
        const id = sel.dataset.offerId;
        if (action === "select-room") {
          state.selectedRoomId = id;
          rerender();
        } else if (action === "select-flight") {
          state.selectedFlightId = id;
          rerender();
        }
        return;
      }
      if (e.target.id === "rb-book-hotel") {
        e.preventDefault();
        if (!state.package_id) return;
        logEvent("booking_click", {
          resort_id: RESORT_ID, click_type: "hotel",
          offer_id: state.selectedRoomId || null,
        });
        const btn = e.target;
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = "Opening Booking.com…";
        try {
          const room = state.rooms.find((r) => r.offer_id === state.selectedRoomId);
          const data = await callFn("generate_booking_redirect", {
            method: "POST",
            body: JSON.stringify({
              package_id: state.package_id,
              selected_offer_id: state.selectedRoomId || null,
              selected_match_path: room?.match_path || null,
              selected_matched_room_id: room?.matched_room_id || null,
              click_type: "hotel",
              session_id: SESSION_ID,
              referer: location.href,
            }),
          });
          if (data.redirect_url) window.open(data.redirect_url, "_blank", "noopener,noreferrer");
          else throw new Error("No redirect_url");
        } catch (err) {
          alert("Could not open the booking partner. " + (err?.message || ""));
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
        return;
      }
      if (e.target.id === "rb-book-flight") {
        e.preventDefault();
        const flight = state.flights.find((f) => f.offer_id === state.selectedFlightId);
        const url = flight?.deep_link || flight?.booking_url || flight?.book_url;
        // Log the flight booking click so it's tracked like hotel clicks
        // (previously this opened the deep-link with no telemetry at all).
        logEvent("booking_click", {
          resort_id: RESORT_ID,
          click_type: "flight",
          offer_id: flight?.offer_id || null,
          total_price: flight?.total_price ?? null,
          has_link: !!url,
        });
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else alert("This fare doesn't have a direct booking link yet. Book the room below and we'll show bookable flights for your dates.");
      }
    });
  }

  // ---- Wire wizard form -------------------------------------------------
  function wireForm() {
    const form = document.querySelector(".seo-wizard-form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      // Strip browser/HTML defaults from the new GET URL — we handle everything in-page.
      const fd = new FormData(form);
      const origin = String(fd.get("origin") || "").trim().toUpperCase();
      const date_start = String(fd.get("date_start") || "");
      const date_end = String(fd.get("date_end") || "");
      if (!origin || !date_start || !date_end) return;
      if (date_end < date_start) {
        setStatus("Check-out must be on or after check-in.", "warn");
        return;
      }
      const party = partyFromForm(form);
      // Replace URL with the search params so refresh/share keeps state,
      // WITHOUT navigating to /.
      const qs = new URLSearchParams({
        origin, date_start, date_end,
        adults: String(party.adults),
        ...(party.kid_ages.length ? { kids: party.kid_ages.join(",") } : {}),
      });
      history.replaceState({}, "", location.pathname + "?" + qs.toString());

      const submit = form.querySelector(".seo-wizard-submit");
      if (submit) { submit.disabled = true; submit.textContent = "Searching…"; }
      try {
        await runFlow({ origin, date_start, date_end, party });
      } catch (err) {
        setStatus(err?.message || "Something went wrong. Try again or refresh.", "error");
      } finally {
        if (submit) { submit.disabled = false; submit.textContent = "See live prices →"; }
      }
    });
  }

  // ---- Hydrate from URL on load -----------------------------------------
  function hydrateFromUrl() {
    const qp = new URLSearchParams(location.search);
    if (![...qp.keys()].length) return;
    const form = document.querySelector(".seo-wizard-form");
    if (!form) return;
    const fields = ["origin", "date_start", "date_end", "adults", "kids"];
    let filledAny = false;
    for (const k of fields) {
      const v = qp.get(k);
      if (v != null && form.elements[k]) {
        form.elements[k].value = v;
        filledAny = true;
      }
    }
    // Only auto-run if the user arrived with a fully-formed deep-link
    // (origin + both dates). Otherwise leave them on the wizard.
    if (filledAny && qp.get("origin") && qp.get("date_start") && qp.get("date_end")) {
      // Defer one tick so paint completes before the network kicks in.
      setTimeout(() => form.requestSubmit?.() || form.dispatchEvent(new Event("submit", { cancelable: true })), 0);
    }
  }

  // ---- Boot -------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    wireForm();
    bindEvents();
    hydrateFromUrl();
  });
})();
