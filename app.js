/* ============================================================
   SCORECARD — boxing round scoring (10-point must)
   Vanilla JS · local device saves + per-user cloud sync
   ============================================================ */
import { CloudSync } from './sync.js';
import { freshState, validateState, importBouts, MAX_STATE_BYTES } from './data.js';

(() => {
  "use strict";

  /* ---------------- constants ---------------- */

  const LS_KEY = "boxing-scorecard.v1";
  const REST_LEN = 60; // seconds between rounds
  const ROUND_LEN_DEFAULT = 180;
  const RESULT_TYPES = [
    ["UD", "Unanimous decision"],
    ["MD", "Majority decision"],
    ["SD", "Split decision"],
    ["Draw", "Draw"],
    ["KO", "Knockout"],
    ["TKO", "Technical knockout"],
    ["RTD", "Retired in corner"],
    ["DQ", "Disqualification"],
    ["NC", "No contest"],
  ];
  const DECISIONS = new Set(["UD", "MD", "SD"]);
  const NO_WINNER = new Set(["Draw", "NC"]);

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : "b_" + Date.now() + "_" + Math.random().toString(36).slice(2));
  const fmtDate = (iso) =>
    new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmtClock = (s) =>
    String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0") + ":" + String(Math.max(0, s) % 60).padStart(2, "0");

  /* ---------------- state ---------------- */

  const emptyDraft = () => ({ winner: "", kd: { red: 0, blue: 0 }, ded: { red: 0, blue: 0 } });

  const state = freshState();
  let draft = state.active ? (state.active.draft || emptyDraft()) : emptyDraft();
  let editingIdx = null; // index of committed round being edited, or null
  let banner = null;     // { text, sub } transient result banner
  let bannerTimer = null;

  function persist() {
    if (state.active) { state.active.draft = draft; state.active.editingIdx = editingIdx; }
    cloud.save(state);
  }

  function applyState(next) {
    stopTimer();
    Object.assign(state, structuredClone(next));
    draft = state.active?.draft || emptyDraft();
    editingIdx = state.active?.editingIdx ?? null;
    timer = { phase: 'idle', remaining: roundLen(state.active), running: false, iv: null };
    ui.viewBout = null; ui.endOpen = false; ui.kd = null;
    render();
  }
  const cloud = new CloudSync({ onState: applyState, onStatus: (message, sync) => {
    const el = $('#sync-status');
    el.textContent = message;
    el.classList.toggle('sync-warning', Boolean(sync.conflict || sync.authRequired || sync.localError));
    if (sync.user) $('#account-email').textContent = sync.user.email;
  } });

  function importHistory(payload) {
    const result = importBouts(state, payload);
    if (state.active?.id !== result.state.active?.id) applyState(result.state);
    else {
      Object.assign(state, result.state);
      draft = state.active?.draft || emptyDraft();
    }
    persist(); render();
    alert(`Imported ${result.added} scorecard${result.added === 1 ? '' : 's'}. ${result.skipped} already present.`);
  }

  function migrateBrowser() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) { alert('No old browser history found. You can import a JSON export instead.'); return; }
      const legacy = validateState(JSON.parse(raw));
      if (!confirm(`Import ${legacy.history.length} previous scorecards${legacy.active ? ' and the fight in progress' : ''} into ${cloud.user.email}?`)) return;
      if (legacy.active && state.active && legacy.active.id !== state.active.id) {
        alert('Finish or discard your current fight before importing the old fight in progress. Your old data is still intact.'); return;
      }
      const result = importBouts(state, { bouts: legacy.history });
      if (legacy.active && !result.state.history.some((b) => b.id === legacy.active.id) && !result.state.active) result.state.active = structuredClone(legacy.active);
      validateState(result.state);
      applyState(result.state); persist();
      alert(`Imported ${result.added} scorecards. Your original browser data has been kept as a backup.`);
    } catch (error) { alert(error.message); }
  }

  function reviewSync() {
    if (cloud.authRequired) { location.reload(); return; }
    if (!cloud.user) { location.reload(); return; }
    if (!cloud.conflict) { cloud.refresh(); return; }
    $('#sync-review')?.remove();
    const panel = document.createElement('div');
    panel.id = 'sync-review'; panel.className = 'overlay';
    panel.innerHTML = `<div class="overlay-panel" style="width:min(580px,100%)">
      <h2>Two devices have different saves</h2>
      <p>Your changes have been kept on this device. Choose which version to use for this account. Export the device copy first if you want to keep both.</p>
      <p>Device: ${state.history.length} saved fights${state.active ? ', one in progress' : ''}. Cloud: ${cloud.conflict.state.history.length} saved fights${cloud.conflict.state.active ? ', one in progress' : ''}.</p>
      <div class="modal-actions">
        <button class="btn" data-sync="export">Export device copy</button>
        <button class="btn" data-sync="cloud">Use cloud copy</button>
        <button class="btn" data-sync="device">Use device copy</button>
        <button class="btn btn-ghost" data-sync="later">Decide later</button>
      </div></div>`;
    panel.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-sync]')?.dataset.sync;
      if (!choice) return;
      if (choice === 'export') { download('scorecard-device-backup.json', JSON.stringify({ ...state, bouts: state.history }, null, 2)); return; }
      if (choice !== 'later') {
        if (!confirm(choice === 'cloud' ? 'Replace the device copy with the cloud copy? A device backup will be retained.' : 'Replace the cloud copy with this device’s current save?')) return;
        try { cloud.resolve(choice === 'cloud'); } catch (error) { alert(error.message); return; }
      }
      panel.remove();
    });
    document.body.append(panel);
  }

  /* ---------------- scoring engine (10-point must) ---------------- */

  // Round winner 10, loser 9; even 10–10. Each knockdown or deduction
  // costs that fighter one point on the round.
  function roundScore(r) {
    let red = 10, blue = 10;
    if (r.winner === "red") blue -= 1;
    else if (r.winner === "blue") red -= 1;
    red = Math.max(0, red - (r.kd.red || 0) - (r.ded.red || 0));
    blue = Math.max(0, blue - (r.kd.blue || 0) - (r.ded.blue || 0));
    return { red, blue };
  }

  const draftEmpty = (d) => !d.winner && !d.kd.red && !d.kd.blue && !d.ded.red && !d.ded.blue;

  function totalsLive(b) {
    let red = 0, blue = 0;
    for (let i = 0; i < b.rounds.length; i++) {
      let r = b.rounds[i];
      if (editingIdx === i) {
        if (draftEmpty(draft)) continue;
        r = draft;
      }
      const s = roundScore(r);
      red += s.red; blue += s.blue;
    }
    if (editingIdx === null && !draftEmpty(draft)) {
      const s = roundScore(draft);
      red += s.red; blue += s.blue;
    }
    return { red, blue };
  }

  function totalsOf(b) {
    let red = 0, blue = 0;
    for (const r of b.rounds) { const s = roundScore(r); red += s.red; blue += s.blue; }
    return { red, blue };
  }

  const roundNo = (b) => b.rounds.length + 1; // next round number (1-based)
  const allScored = (b) => b.rounds.length >= (b.roundsTotal || 0) && editingIdx === null && draftEmpty(draft);

  /* ---------------- timer + audio ---------------- */

  let timer = { phase: "idle", remaining: ROUND_LEN_DEFAULT, running: false, iv: null };
  let actx = null;

  function audio() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    return actx;
  }

  // Synthesized boxing bell: struck partials with exponential decay.
  function strike(partials, dur) {
    try {
      const ctx = audio(), t = ctx.currentTime;
      for (const [f, g] of partials) {
        const o = ctx.createOscillator(), gn = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        gn.gain.setValueAtTime(0, t);
        gn.gain.linearRampToValueAtTime(g, t + 0.006);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(gn); gn.connect(ctx.destination);
        o.start(t); o.stop(t + dur + 0.1);
      }
    } catch {}
  }
  const bell = () => strike([[660, .5], [990, .3], [1320, .2], [1650, .11], [1980, .06]], 2.4);
  const ding = () => strike([[880, .32], [1320, .16]], .6);

  function roundLen(b) { return (b && b.roundLen) || ROUND_LEN_DEFAULT; }

  function stopTimer() {
    timer.running = false;
    if (timer.iv) { clearInterval(timer.iv); timer.iv = null; }
  }

  function tick() {
    if (!timer.running) return;
    timer.remaining--;
    if (timer.phase === "round" && timer.remaining === 10) ding(); // 10-second warning
    if (timer.remaining <= 0) {
      timer.running = false;
      if (timer.phase === "round") {
        bell();
        timer.phase = "rest";
        timer.remaining = REST_LEN;
      } else if (timer.phase === "rest") {
        timer.phase = "idle";
        timer.remaining = roundLen(state.active);
      } else {
        timer.phase = "idle";
      }
    }
    renderClock();
  }

  function toggleClock() {
    if (!state.active) return;
    audio();
    if (timer.running) { timer.running = false; renderClock(); return; }
    if (timer.phase === "rest") { // skip the rest, straight into next round
      bell();
      timer.phase = "round";
      timer.remaining = roundLen(state.active);
    } else if (timer.phase === "idle") {
      bell();
      timer.phase = "round";
      timer.remaining = roundLen(state.active);
    }
    timer.running = true;
    renderClock();
  }

  function clockReset() {
    timer.running = false;
    timer.phase = timer.phase === "rest" ? "rest" : "idle";
    timer.remaining = timer.phase === "rest" ? REST_LEN : roundLen(state.active);
    renderClock();
  }

  /* ---------------- actions ---------------- */

  const ACTIONS = {
    'sync-retry': reviewSync,
    'history-import': () => $('#history-file').click(),
    'history-migrate': migrateBrowser,
    'history-prev': () => { ui.historyPage = Math.max(0, ui.historyPage - 1); renderOverlays(); },
    'history-next': () => { ui.historyPage++; renderOverlays(); },
    "history-open": () => { ui.historyOpen = true; ui.historyPage = 0; ui.viewBout = null; renderOverlays(); },
    "history-close": () => { ui.historyOpen = false; ui.viewBout = null; renderOverlays(); },
    "history-view": (el) => { ui.historyOpen = true; ui.viewBout = state.history.find((b) => b.id === el.dataset.id); renderOverlays(); },
    "history-back": () => { ui.viewBout = null; renderOverlays(); },
    "history-delete": (el) => {
      const b = state.history.find((x) => x.id === el.dataset.id);
      if (b && confirm(`Delete ${b.red.name} vs ${b.blue.name} from history?`)) {
        state.history = state.history.filter((x) => x.id !== b.id);
        persist(); render(); // refresh the underlying screen (recent list) too
      }
    },
    "history-export": (el) => {
      const b = state.history.find((x) => x.id === el.dataset.id);
      if (b) exportBout(b);
    },
    "export-all": () => {
      const payload = { exportedAt: new Date().toISOString(), bouts: state.history, active: state.active, prefs: state.prefs };
      download("scorecard-history.json", JSON.stringify(payload, null, 2));
    },
    "new-bout": () => {
      if (state.active && !confirm("Discard the bout in progress and start a new one?")) return;
      resetBoutState();
      render();
    },
    "discard-bout": () => {
      if (!confirm("Discard this bout without saving? It will be removed.")) return;
      resetBoutState();
      render();
    },
    "end-bout": () => { ui.endOpen = true; renderOverlays(); },
    "end-close": () => { ui.endOpen = false; renderOverlays(); },
    "end-submit": () => finishBout(),
    "round-next": () => nextRound(),
    "round-save": () => saveEdit(),
    "round-cancel": () => { editingIdx = null; draft = emptyDraft(); persist(); render(); },
    "set-winner": (el) => setWinner(el.dataset.side),
    "kd": (el) => kdTick(el.dataset.side),
    "ded": (el) => dedTick(el.dataset.side, el.dataset.dir),
    "edit-round": (el) => startEdit(+el.dataset.idx),
    "del-round": (el) => delRound(+el.dataset.idx),
    "clock-toggle": () => toggleClock(),
    "clock-reset": () => clockReset(),
    "kd-count": () => kdStep(),
    "kd-close": () => { ui.kd = null; renderOverlays(); },
    "print-card": () => window.print(),
  };

  function resetBoutState() {
    state.active = null; draft = emptyDraft(); editingIdx = null;
    stopTimer(); ui.endOpen = false; ui.historyOpen = false; ui.kd = null;
    timer = { phase: "idle", remaining: roundLen(null), running: false, iv: null };
    persist();
  }

  function setWinner(side) {
    if (!state.active) return;
    if (allScored(state.active)) return;
    draft.winner = draft.winner === side ? "" : side;
    persist(); render();
  }

  function kdTick(side) {
    const b = state.active;
    if (!b || allScored(b)) return;
    draft.kd[side]++;
    // Landing the first knockdown usually decides the round: default the winner.
    if (!draft.winner) draft.winner = side === "red" ? "blue" : "red";
    ui.kd = { side, count: 0 };
    persist(); render();
    renderOverlays(); // open referee count over the fresh render
  }

  function dedTick(side, dir) {
    if (!state.active || allScored(state.active)) return;
    draft.ded[side] = Math.max(0, draft.ded[side] + (dir === "up" ? 1 : -1));
    persist(); render();
  }

  // Referee count: tap to 8, then the fight resumes.
  function kdStep() {
    if (!ui.kd) return;
    ui.kd.count++;
    ding();
    renderOverlays();
    if (ui.kd.count >= 8) bell(); // "up" — ring the fighter back in
  }

  function nextRound() {
    const b = state.active;
    if (!b || allScored(b)) return;
    if (editingIdx !== null) { saveEdit(); return; }
    if (!draftEmpty(draft)) b.rounds.push({ winner: draft.winner, kd: { ...draft.kd }, ded: { ...draft.ded } });
    draft = emptyDraft();
    timer.phase = "idle"; timer.running = false;
    timer.remaining = roundLen(b);
    persist(); render();
  }

  function startEdit(idx) {
    const b = state.active;
    if (!b || !b.rounds[idx]) return;
    if (!draftEmpty(draft)) return; // finish the current round first
    const r = b.rounds[idx];
    draft = { winner: r.winner, kd: { ...r.kd }, ded: { ...r.ded } };
    editingIdx = idx;
    persist(); render();
  }

  function saveEdit() {
    const b = state.active;
    if (editingIdx === null) { nextRound(); return; }
    if (draftEmpty(draft)) b.rounds.splice(editingIdx, 1);
    else b.rounds[editingIdx] = { winner: draft.winner, kd: { ...draft.kd }, ded: { ...draft.ded } };
    editingIdx = null; draft = emptyDraft();
    persist(); render();
  }

  function delRound(idx) {
    const b = state.active;
    if (!b || !b.rounds[idx]) return;
    if (!confirm(`Delete round ${idx + 1}?`)) return;
    b.rounds.splice(idx, 1);
    if (editingIdx !== null) { editingIdx = null; draft = emptyDraft(); }
    persist(); render();
  }

  function finishBout() {
    const b = state.active;
    if (!b) return;
    const type = $("#end-type").value;
    const checked = $("#end-win input:checked");
    const roundEl = $("#end-round");
    const note = $("#end-note").value.trim();
    let winner = checked ? checked.value : "";
    let rnd = roundEl && roundEl.value ? +roundEl.value : null;

    if (DECISIONS.has(type)) {
      const t = totalsLive(b);
      const lead = t.red === t.blue ? null : (t.red > t.blue ? "red" : "blue");
      if (!winner) winner = lead || "";
      if (type !== "Draw" && !winner) { alert("No winner on the card and no decision picked — choose a winner or pick Draw."); return; }
      if (type === "Draw" && winner) { winner = ""; }
      rnd = null; // decisions carry no stoppage round
    } else if (NO_WINNER.has(type)) {
      winner = "";
      rnd = null;
    } else {
      if (!winner) { alert("Pick the winner."); return; }
      if (!rnd || rnd < 1 || rnd > (b.roundsTotal || 99)) { alert("Enter the round of the stoppage (1–" + (b.roundsTotal || 12) + ")."); return; }
    }

    // Restore an in-progress edit correctly when finishing from another device.
    if (editingIdx !== null) {
      if (draftEmpty(draft)) b.rounds.splice(editingIdx, 1);
      else b.rounds[editingIdx] = { winner: draft.winner, kd: { ...draft.kd }, ded: { ...draft.ded } };
    } else if (!draftEmpty(draft)) b.rounds.push({ winner: draft.winner, kd: { ...draft.kd }, ded: { ...draft.ded } });
    b.draft = null; b.editingIdx = null; draft = emptyDraft(); editingIdx = null;

    b.result = { type, winner: winner || null, round: rnd, note };
    b.status = "done";
    b.endedAt = new Date().toISOString();
    state.history.unshift(b);
    state.active = null;
    stopTimer();
    ui.endOpen = false;

    const t = totalsOf(b);
    const who = winner ? (winner === "red" ? b.red.name + " · red corner" : b.blue.name + " · blue corner") : "—";
    banner = {
      text: `${who} wins by ${type}${rnd ? " — round " + rnd : ""}`,
      sub: `Final card: ${t.red}–${t.blue}`,
    };
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { banner = null; render(); }, 8000);
    persist(); render();
  }

  /* ---------------- export ---------------- */

  function download(name, content) {
    const blob = new Blob([content], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function exportBout(b) {
    const t = totalsOf(b);
    download(
      `bout-${b.date.slice(0, 10)}-${b.red.name}-vs-${b.blue.name}.json`.replace(/[^a-z0-9._-]+/gi, "-"),
      JSON.stringify({ bout: b, finalCard: t, result: b.result }, null, 2)
    );
  }

  /* ---------------- ui state ---------------- */

  const ui = { historyOpen: false, historyPage: 0, viewBout: null, endOpen: false, kd: null };

  /* ---------------- rendering ---------------- */

  function render() {
    const app = $("#app");
    app.innerHTML = state.active ? liveHTML() : setupHTML();
    $("#nav-new-bout").hidden = !state.active;
    if (state.active) {
      if (!timer.iv) timer.iv = setInterval(tick, 1000);
      if (timer.phase === "idle") timer.remaining = roundLen(state.active);
    } else {
      stopTimer();
    }
    bindSetup();
    updatePrintout();
    renderOverlays(); // keep modals/overlays in sync with state changes
  }

  function renderClock() {
    const el = $("#clock");
    if (!el) return;
    el.textContent = fmtClock(timer.remaining);
    el.className = "clock " + (timer.phase === "rest" ? "rest-clock" : timer.running ? "live-clock" : "");
    const phase = $("#clock-phase");
    if (phase) {
      const b = state.active;
      const label = timer.phase === "rest" ? "Rest" : timer.running ? `Round ${roundNo(b)}` : "Ready";
      phase.textContent = timer.running ? "● " + label : label;
    }
    const btn = $("#clock-toggle");
    if (btn) btn.textContent = timer.running ? "Pause" : timer.phase === "rest" ? "Skip rest" : "Start round";
  }

  /* ----- setup ----- */

  const setup = { redName: "", blueName: "", weight: "", venue: "" };

  function setupHTML() {
    const roundsSel = [4, 6, 8, 10, 12]
      .map((n) => `<option value="${n}"${n === state.prefs.rounds ? " selected" : ""}>${n} rounds</option>`).join("");
    const lenSel = [
      [180, "3:00 · pro men"], [120, "2:00 · women"], [90, "1:30 · amateur"],
    ].map(([v, l]) => `<option value="${v}"${v === state.prefs.roundLen ? " selected" : ""}>${l}</option>`).join("");

    const bannerHTML = banner
      ? `<div class="banner"><div class="banner-main">${esc(banner.text)}</div><div class="banner-sub">${esc(banner.sub)}</div></div>`
      : "";

    const recent = state.history.slice(0, 5).map((b) => {
      const t = totalsOf(b);
      const res = b.result
        ? `${b.result.winner ? (b.result.winner === "red" ? b.red.name : b.blue.name) + " · " : ""}${b.result.type}${b.result.round ? " R" + b.result.round : ""}`
        : "incomplete";
      return `<div class="bout-row">
        <div class="bout-fighters">
          <div class="names">${esc(b.red.name)} <span class="v">vs</span> ${esc(b.blue.name)}</div>
          <div class="meta">${fmtDate(b.date)} · ${t.red}–${t.blue}${b.weightClass ? " · " + esc(b.weightClass) : ""}</div>
        </div>
        <div class="bout-result">${esc(res)}</div>
        <div class="bout-ops">
          <button class="btn btn-sm" data-action="history-view" data-id="${b.id}">Card</button>
          <button class="btn btn-sm" data-action="history-delete" data-id="${b.id}">Delete</button>
        </div>
      </div>`;
    }).join("");

    return `<div class="screen">
      <div class="setup-head">
        <h1>Seconds out</h1>
        <p>Score the bout round by round on the 10-point must. Tick knockdowns, deductions and who took the round — the card keeps itself.</p>
      </div>
      ${bannerHTML}
      <div class="migration-hint"><span>Have scorecards from before cloud saves?</span> <button class="btn btn-sm" data-action="history-migrate">Import old browser data</button> <button class="btn btn-sm" data-action="history-import">Import JSON</button></div>
      <div class="setup-grid">
        <div class="corner-card red">
          <label>Red corner</label>
          <input class="field" data-model="redName" placeholder="Fighter name" value="${esc(setup.redName)}" autocomplete="off">
        </div>
        <div class="setup-mid">
          <div class="select-row"><span>Rounds</span><select class="field" data-model="rounds">${roundsSel}</select></div>
          <div class="select-row"><span>Round length</span><select class="field" data-model="roundLen">${lenSel}</select></div>
          <div class="select-row"><span>Weight class</span><input class="field" data-model="weight" placeholder="e.g. Welterweight" value="${esc(setup.weight)}" autocomplete="off"></div>
        </div>
        <div class="corner-card blue">
          <label>Blue corner</label>
          <input class="field" data-model="blueName" placeholder="Fighter name" value="${esc(setup.blueName)}" autocomplete="off">
        </div>
      </div>
      <div class="setup-actions">
        <button class="btn btn-gold" id="start-bout" style="padding:14px 28px;font-size:15px">Start the bout</button>
      </div>
      <div class="how-box">
        <div><b>10–9</b> round winner takes it <code>10</code>, loser <code>9</code>.</div>
        <div><b>10–8</b> a knockdown or deduction costs that fighter a point — two downs is <code>10–7</code>.</div>
        <div><b>10–10</b> an even round. Down in a round you win? The point still comes off.</div>
      </div>
      ${recent ? `<div class="panel" style="margin-top:26px"><div class="panel-title">Recent bouts</div>${recent}</div>` : ""}
    </div>`;
  }

  function bindSetup() {
    if (!state.active) {
      $("#app").querySelectorAll("[data-model]").forEach((el) => {
        const model = el.dataset.model;
        el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
          if (model === "redName") setup.redName = el.value;
          else if (model === "blueName") setup.blueName = el.value;
          else if (model === "weight") setup.weight = el.value;
          else if (model === "rounds") { state.prefs.rounds = +el.value; persist(); }
          else if (model === "roundLen") { state.prefs.roundLen = +el.value; persist(); }
          const btn = $("#start-bout");
          if (btn) btn.disabled = !setup.redName.trim() || !setup.blueName.trim();
        });
      });
      const btn = $("#start-bout");
      btn.disabled = !setup.redName.trim() || !setup.blueName.trim();
      btn.addEventListener("click", startBout);
    }
  }

  function startBout() {
    const red = setup.redName.trim() || "Red corner";
    const blue = setup.blueName.trim() || "Blue corner";
    state.active = {
      id: uid(),
      red: { name: red }, blue: { name: blue },
      weightClass: setup.weight.trim(),
      roundsTotal: state.prefs.rounds,
      roundLen: state.prefs.roundLen,
      rounds: [],
      status: "active",
      result: null,
      date: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    draft = emptyDraft();
    editingIdx = null;
    timer = { phase: "idle", remaining: state.prefs.roundLen, running: false, iv: null };
    ui.historyOpen = false; ui.viewBout = null; ui.endOpen = false; ui.kd = null;
    persist(); render();
  }

  /* ----- live ----- */

  function liveHTML() {
    const b = state.active;
    const t = totalsLive(b);
    const lead = t.red === t.blue ? null : (t.red > t.blue ? "red" : "blue");
    const leadClass = lead ? (lead === "red" ? "lead-red" : "lead-blue") : "tie";
    const round = editingIdx !== null ? editingIdx + 1 : roundNo(b);
    const editing = editingIdx !== null;
    const done = allScored(b);

    const kdTotal = (side) => b.rounds.reduce((n, r) => n + (r.kd[side] || 0), 0) + (draftEmpty(draft) ? 0 : draft.kd[side]);
    const dedTotal = (side) => b.rounds.reduce((n, r) => n + (r.ded[side] || 0), 0) + (draftEmpty(draft) ? 0 : draft.ded[side]);

    const cur = draftEmpty(draft) && !editing ? null : draft;
    const curScore = cur ? roundScore(cur) : { red: 10, blue: 10 };
    const kdNote = (cur && (cur.kd.red + cur.kd.blue)) ? ` · ${cur.kd.red + cur.kd.blue} down` : "";
    const dedNote = (cur && (cur.ded.red + cur.ded.blue)) ? ` · ${cur.ded.red + cur.ded.blue} deducted` : "";

    const segBtn = (side, label) =>
      `<button class="seg-btn ${side}" data-action="set-winner" data-side="${side}" aria-pressed="${cur && cur.winner === side}">${label}</button>`;

    const eventCell = (side, label, cls) => `
      <div class="event-cell ${cls}">
        <div class="event-head"><span>${label}</span><span class="count" data-n="${cur ? cur.kd[side] : 0}">${cur ? cur.kd[side] : 0}</span></div>
        <div class="event-btns">
          <button class="btn btn-sm" data-action="kd" data-side="${side}">+ Down</button>
        </div>
      </div>`;

    const dedCell = (side, cls) => `
      <div class="event-cell ${cls}">
        <div class="event-head"><span>Deduction (−1)</span><span class="count" data-n="${cur ? cur.ded[side] : 0}">${cur ? cur.ded[side] : 0}</span></div>
        <div class="event-btns">
          <button class="btn btn-sm" data-action="ded" data-side="${side}" data-dir="up" ${cur && cur.ded[side] >= 3 ? "disabled" : ""}>+ Foul</button>
          <button class="btn btn-sm" data-action="ded" data-side="${side}" data-dir="down" ${cur && cur.ded[side] <= 0 ? "disabled" : ""}>−</button>
        </div>
      </div>`;

    const rows = b.rounds.map((r, i) => {
      const s = roundScore(r);
      const run = { red: 0, blue: 0 };
      for (let j = 0; j <= i; j++) { const ss = roundScore(b.rounds[j]); run.red += ss.red; run.blue += ss.blue; }
      const winCls = r.winner === "red" ? "win-red" : r.winner === "blue" ? "win-blue" : "win-even";
      const mark = r.winner === "red" ? "● RED" : r.winner === "blue" ? "● BLUE" : "EVEN";
      const kdM = (r.kd.red ? ` D${r.kd.red}` : "") + (r.kd.blue ? ` d${r.kd.blue}` : "");
      const isEditing = editingIdx === i;
      return `<div class="card-row ${winCls}${isEditing ? " editing" : ""}">
        <span class="round-no">R${i + 1}</span>
        <span class="mark">${mark}${kdM ? `<span style="color:var(--gold)">${kdM}</span>` : ""}</span>
        <span class="s-red">${s.red}</span>
        <span class="s-blue">${s.blue}</span>
        <span class="run">${run.red}<span class="ld-r">–</span>${run.blue}</span>
        <span class="row-ops">
          <button class="icon-btn" data-action="edit-round" data-idx="${i}" title="Edit round ${i + 1}">✎</button>
          <button class="icon-btn del" data-action="del-round" data-idx="${i}" title="Delete round ${i + 1}">×</button>
        </span>
      </div>`;
    }).join("");

    const curWin = cur && cur.winner === "red" ? "red" : cur && cur.winner === "blue" ? "blue" : null;
    const curScoreClass = curWin === "red" ? "r-red" : curWin === "blue" ? "r-blue" : "";

    const roundPanel = done ? `
      <div class="panel round-panel">
        <div class="round-head"><h2>All rounds scored</h2><span class="round-note">End the bout below</span></div>
      </div>` : `
      <div class="panel round-panel">
        <div class="round-head">
          <h2>${editing ? `Editing round ${round}` : `Round ${round}`}</h2>
          <span class="round-note">${editing ? "Editing a scored round" : `of ${b.roundsTotal}`}</span>
        </div>
        <div class="winner-row">
          <div class="row-label">Who won the round?</div>
          <div class="segmented">${segBtn("red", "Red")}${segBtn("even", "Even")}${segBtn("blue", "Blue")}</div>
        </div>
        <div class="event-row">
          ${eventCell("red", "Down?", "red")}
          ${eventCell("blue", "Down?", "blue")}
          ${dedCell("red", "red")}
          ${dedCell("blue", "blue")}
        </div>
        <div class="round-score-line">
          <div>
            <div class="round-score"><span class="r-red">${curScore.red}</span><span> – </span><span class="r-blue">${curScore.blue}</span></div>
            <div class="round-score-note">10-point must${kdNote}${dedNote}</div>
          </div>
          <div class="round-actions">
            ${editing
              ? `<button class="btn btn-gold" data-action="round-save">Save changes</button><button class="btn btn-ghost" data-action="round-cancel">Cancel</button>`
              : `<button class="btn btn-gold" data-action="round-next">Next round →</button>`}
          </div>
        </div>
        ${!editing ? `<div class="hint-line"><kbd>R</kbd> red wins · <kbd>E</kbd> even · <kbd>B</kbd> blue wins · <kbd>Space</kbd> clock</div>` : ""}
      </div>`;

    const cardFoot = done
      ? `<div class="card-foot"><span style="color:var(--gold);font-weight:600">Card complete — announce the result.</span>
         <button class="btn btn-gold" data-action="end-bout">End bout &amp; record result</button></div>`
      : `<div class="card-foot">
          <span style="color:var(--dim);font-size:12.5px">${b.rounds.length}/${b.roundsTotal} rounds scored</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" data-action="print-card">Print card</button>
            <button class="btn btn-sm" data-action="discard-bout">Discard</button>
            <button class="btn btn-sm btn-danger" data-action="end-bout">End bout</button>
          </div>
        </div>`;

    return `<div class="screen">
      <div class="live-meta">
        <b>${esc(b.red.name)}</b> <span style="color:var(--red)">●</span> vs <span style="color:var(--blue)">●</span> <b>${esc(b.blue.name)}</b>
        <span>·</span> ${esc(b.weightClass || "—")}
        <span>·</span> ${b.roundsTotal} rounds · ${fmtClock(b.roundLen)} rounds
      </div>

      <div class="clock-row">
        <div>
          <div class="clock-phase" id="clock-phase">Ready</div>
          <div class="clock" id="clock">${fmtClock(timer.remaining)}</div>
        </div>
        <div class="clock-btns">
          <button class="btn" id="clock-toggle" data-action="clock-toggle">Start round</button>
          <button class="btn btn-ghost" data-action="clock-reset">Reset</button>
        </div>
      </div>

      <div class="scoreboard">
        <div class="corner red">
          <div class="corner-tag">Red corner</div>
          <div class="corner-name">${esc(b.red.name)}</div>
          <div class="corner-stats">
            <span class="stat-chip ${kdTotal("red") ? "down" : ""}">DOWN ×${kdTotal("red")}</span>
            <span class="stat-chip ${dedTotal("red") ? "ded" : ""}">DED ×${dedTotal("red")}</span>
          </div>
        </div>
        <div class="center-panel">
          <div class="center-totals"><span class="${leadClass}">${t.red}</span><span class="tie"> – </span><span class="${leadClass}">${t.blue}</span></div>
          <div class="center-sub">${b.rounds.length} round${b.rounds.length === 1 ? "" : "s"} scored</div>
        </div>
        <div class="corner blue">
          <div class="corner-tag">Blue corner</div>
          <div class="corner-name">${esc(b.blue.name)}</div>
          <div class="corner-stats">
            <span class="stat-chip ${kdTotal("blue") ? "blue-down" : ""}">DOWN ×${kdTotal("blue")}</span>
            <span class="stat-chip ${dedTotal("blue") ? "ded" : ""}">DED ×${dedTotal("blue")}</span>
          </div>
        </div>
      </div>

      ${roundPanel}

      <div class="card-table">
        <div class="card-head"><span>Round</span><span>Winner</span><span style="text-align:right">Red</span><span style="text-align:right">Blue</span><span style="text-align:right">Card</span><span></span></div>
        ${rows || `<div class="empty-card">No rounds yet — score round one above.</div>`}
        ${cardFoot}
      </div>
    </div>`;
  }

  /* ----- overlays ----- */

  function renderOverlays() {
    const wrap = $("#overlays");
    let html = "";

    if (ui.kd) {
      const side = ui.kd.side;
      const name = state.active[side].name;
      const done = ui.kd.count >= 8;
      html += `<div class="kd-overlay kd-card ${side}">
        <div class="kd-card">
          <div class="kd-corner">${side === "red" ? "Red corner" : "Blue corner"} · down</div>
          <div class="kd-number">${done ? "UP" : ui.kd.count}</div>
          ${done
            ? `<button class="kd-count-btn" data-action="kd-close">Resume</button><div style="margin-top:10px;color:var(--ok);font-weight:600;font-size:14px">Fight continues</div>`
            : `<button class="kd-count-btn" data-action="kd-count">Count</button>
               <div style="margin-top:10px;color:var(--muted);font-size:13px">${esc(name)} — referee count · tap to 8</div>
               <button class="kd-skip" data-action="kd-close">skip count</button>`}
        </div>
      </div>`;
    }

    if (ui.endOpen && state.active) {
      const b = state.active;
      const t = totalsLive(b);
      const lead = t.red === t.blue ? "" : (t.red > t.blue ? "red" : "blue");
      const typeOpts = RESULT_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
      const defaultRound = Math.max(1, b.rounds.length);
      html += `<div class="overlay"><div class="overlay-panel">
        <div class="overlay-head"><h2>End the bout</h2><button class="icon-btn" data-action="end-close" title="Close">×</button></div>
        <div class="detail-line"><span>Card heading into the result</span><b>${t.red}–${t.blue}${lead ? (lead === "red" ? " (red leads)" : " (blue leads)") : " (even)"}</b></div>
        <div class="form-row" style="margin-top:14px">
          <label for="end-type">Result</label>
          <select class="field" id="end-type">${typeOpts}</select>
        </div>
        <div class="form-row">
          <label>Winner</label>
          <div class="radio-line" id="end-win">
            <label><input type="radio" name="endwin" value="red" ${lead === "red" ? "checked" : ""}> <span style="color:var(--red);font-weight:700">●</span> ${esc(b.red.name)}</label>
            <label><input type="radio" name="endwin" value="blue" ${lead === "blue" ? "checked" : ""}> <span style="color:var(--blue);font-weight:700">●</span> ${esc(b.blue.name)}</label>
          </div>
          <div class="hint" id="end-win-hint">Decisions default to the scorecard leader — change if you like.</div>
        </div>
        <div class="form-row" id="end-round-row">
          <label for="end-round">Round of stoppage</label>
          <input class="field" id="end-round" type="number" min="1" max="${b.roundsTotal}" value="${defaultRound}" style="max-width:120px">
        </div>
        <div class="form-row">
          <label for="end-note">Note (optional)</label>
          <input class="field" id="end-note" placeholder="e.g. referee stopped it on the feet" autocomplete="off">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-action="end-close">Cancel</button>
          <button class="btn btn-gold" data-action="end-submit">Record result</button>
        </div>
      </div></div>`;
    } else if (ui.historyOpen) {
      if (ui.viewBout) {
        const b = ui.viewBout;
        const t = totalsOf(b);
        const rows = b.rounds.map((r, i) => {
          const s = roundScore(r);
          return `<tr><td>${i + 1}</td><td>${r.winner === "red" ? "● Red" : r.winner === "blue" ? "● Blue" : "Even"}${(r.kd.red ? ` · KD×${r.kd.red}` : "")}${(r.kd.blue ? ` · KD×${r.kd.blue}` : "")}${(r.ded.red + r.ded.blue ? " · −1" : "")}</td><td>${s.red}</td><td>${s.blue}</td></tr>`;
        }).join("");
        const res = b.result;
        const resHTML = res ? `<div class="detail-result">
          <div class="who">${res.winner ? esc(res.winner === "red" ? b.red.name : b.blue.name) : "No winner"}</div>
          <div class="how">${res.type}${res.round ? " · round " + res.round : ""}${res.note ? " · " + esc(res.note) : ""}</div>
          <div class="how">Final card ${t.red}–${t.blue}</div>
        </div>` : "";
        html += `<div class="overlay"><div class="overlay-panel" style="width:min(640px,100%)">
          <div class="overlay-head"><h2>${esc(b.red.name)} vs ${esc(b.blue.name)}</h2><button class="icon-btn" data-action="history-close" title="Close">×</button></div>
          <div class="detail-line"><span>Date</span><b>${fmtDate(b.date)}</b></div>
          ${b.weightClass ? `<div class="detail-line"><span>Weight class</span><b>${esc(b.weightClass)}</b></div>` : ""}
          <div class="detail-line"><span>Scheduled</span><b>${b.roundsTotal} rounds</b></div>
          <div class="detail-line"><span>Rounds scored</span><b>${b.rounds.length}</b></div>
          ${resHTML}
          <table class="print-table" style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:var(--bg-2)"><th style="padding:6px;border:1px solid var(--line)">R</th><th style="padding:6px;border:1px solid var(--line)">Winner</th><th style="padding:6px;border:1px solid var(--line)">${esc(b.red.name)}</th><th style="padding:6px;border:1px solid var(--line)">${esc(b.blue.name)}</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr style="font-weight:700"><td colspan="2" style="padding:6px;border:1px solid var(--line)">Total</td><td style="padding:6px;border:1px solid var(--line);color:var(--red)">${t.red}</td><td style="padding:6px;border:1px solid var(--line);color:var(--blue)">${t.blue}</td></tr></tfoot>
          </table>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-action="history-back">Back</button>
            <button class="btn" data-action="print-card">Print card</button>
            <button class="btn" data-action="history-export" data-id="${b.id}">Export JSON</button>
            <button class="btn btn-danger" data-action="history-delete" data-id="${b.id}">Delete</button>
          </div>
        </div></div>`;
      } else {
        ui.historyPage = Math.min(ui.historyPage, Math.max(0, Math.ceil(state.history.length / 20) - 1));
        const rows = state.history.length
          ? state.history.slice(ui.historyPage * 20, (ui.historyPage + 1) * 20).map((b) => {
              const t = totalsOf(b);
              const res = b.result ? b.result.type + (b.result.round ? " R" + b.result.round : "") : "—";
              const drawish = b.result && (b.result.type === "Draw" || b.result.type === "NC");
              return `<div class="bout-row">
                <div class="bout-fighters">
                  <div class="names">${esc(b.red.name)} <span class="v">vs</span> ${esc(b.blue.name)}</div>
                  <div class="meta">${fmtDate(b.date)} · ${b.rounds.length}/${b.roundsTotal} rounds · card ${t.red}–${t.blue}${b.weightClass ? " · " + esc(b.weightClass) : ""}</div>
                </div>
                <div class="bout-result ${drawish ? "draw" : ""}">${esc(res)}</div>
                <div class="bout-ops">
                  <button class="btn btn-sm" data-action="history-view" data-id="${b.id}">Card</button>
                  <button class="btn btn-sm" data-action="history-export" data-id="${b.id}">JSON</button>
                  <button class="btn btn-sm btn-danger" data-action="history-delete" data-id="${b.id}">Delete</button>
                </div>
              </div>`;
            }).join("")
          : `<div class="empty-card">No bouts yet. Score your first and it will land here.</div>`;
        html += `<div class="overlay"><div class="overlay-panel" style="width:min(680px,100%)">
          <div class="overlay-head"><h2>Bout history</h2><button class="icon-btn" data-action="history-close" title="Close">×</button></div>
          ${rows}
          <div class="modal-actions">
            ${state.history.length > 20 ? `<button class="btn" data-action="history-prev" ${ui.historyPage === 0 ? 'disabled' : ''}>Previous</button><span>${ui.historyPage + 1} / ${Math.ceil(state.history.length / 20)}</span><button class="btn" data-action="history-next" ${(ui.historyPage + 1) * 20 >= state.history.length ? 'disabled' : ''}>Next</button>` : ''}
            <button class="btn" data-action="history-import">Import JSON</button>
            <button class="btn" data-action="history-migrate">Import old browser data</button>
            <button class="btn" data-action="export-all" ${state.history.length || state.active ? "" : "disabled"}>Export all JSON</button>
          </div>
        </div></div>`;
      }
    }

    wrap.innerHTML = html;
    bindEndModal();
    updatePrintout(); // print target follows the bout being viewed
  }

  function bindEndModal() {
    const sel = $("#end-type");
    if (!sel) return;
    const winRow = $("#end-win");
    const roundRow = $("#end-round-row");
    const hint = $("#end-win-hint");
    const sync = () => {
      const type = sel.value;
      const decision = DECISIONS.has(type);
      const noWin = NO_WINNER.has(type);
      winRow.style.display = noWin ? "none" : "";
      roundRow.style.display = decision ? "none" : "";
      hint.textContent = decision
        ? "Decisions default to the scorecard leader — change if you like."
        : noWin
          ? "No winner — the bout is a draw / no contest."
          : "Round of the stoppage (KO, TKO, retirement, DQ).";
      winRow.querySelectorAll("input").forEach((i) => { i.disabled = noWin; if (noWin) i.checked = false; });
      if (decision && !winRow.querySelector("input:checked")) {
        // restore scorecard leader default if none selected
        const b = state.active; const t = totalsLive(b);
        if (t.red > t.blue) winRow.querySelector('input[value="red"]').checked = true;
        else if (t.blue > t.red) winRow.querySelector('input[value="blue"]').checked = true;
      }
    };
    sel.addEventListener("change", sync);
    sync();
  }

  /* ----- print ----- */

  function updatePrintout() {
    const out = $("#printout");
    const b = ui.viewBout || state.active;
    if (!b) { out.innerHTML = ""; return; }
    const t = totalsOf(b);
    const rows = b.rounds.map((r, i) => {
      const s = roundScore(r);
      return `<tr><td>${i + 1}</td><td>${r.winner === "red" ? "Red" : r.winner === "blue" ? "Blue" : "Even"}</td><td>${s.red}</td><td>${s.blue}</td></tr>`;
    }).join("");
    out.innerHTML = `<div class="print-head">
      <h1>${esc(b.red.name)} vs ${esc(b.blue.name)}</h1>
      <p>${b.weightClass ? esc(b.weightClass) + " · " : ""}${fmtDate(b.date)} · ${b.rounds.length}/${b.roundsTotal} rounds</p>
    </div>
    <table class="print-table">
      <thead><tr><th>Round</th><th>Winner</th><th>${esc(b.red.name)}</th><th>${esc(b.blue.name)}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th colspan="2">Total</th><th>${t.red}</th><th>${t.blue}</th></tr></tfoot>
    </table>
    <div class="print-result">${b.result ? `${b.result.winner ? esc(b.result.winner === "red" ? b.red.name : b.blue.name) + " wins by " : ""}${b.result.type}${b.result.round ? " (round " + b.result.round + ")" : ""} — ${t.red}–${t.blue}` : ""}</div>`;
  }

  /* ----- keyboard shortcuts ----- */

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (ui.kd || ui.endOpen || ui.historyOpen) return;
    if (!state.active) return;
    if (e.code === "Space") { e.preventDefault(); toggleClock(); }
    else if (e.key === "r" || e.key === "R") setWinner("red");
    else if (e.key === "b" || e.key === "B") setWinner("blue");
    else if (e.key === "e" || e.key === "E") setWinner("even");
  });

  /* ----- delegated clicks ----- */

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    if (!cloud.user && el.dataset.action !== 'sync-retry') return;
    const fn = ACTIONS[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });

  /* ----- go ----- */

  // Debug/testing handle (harmless, no page UI).
  window.__scorecard = { get timer() { return timer; }, state, draft: () => draft, ui };

  // Restore a stale in-progress draft pointer.
  $('#history-file').addEventListener('change', async (event) => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_STATE_BYTES) throw new Error('Export is too large to import.');
      importHistory(JSON.parse(await file.text()));
    } catch (error) { alert(error.message); }
  });
  $('#app').innerHTML = '<div class="screen"><h1>Opening your scorecards…</h1><p>Checking your account and cloud history.</p></div>';
  cloud.start().then((ready) => {
    if (!ready) $('#app').innerHTML = '<div class="screen"><h1>Unable to open your account</h1><p>Reconnect and retry to load your personal history.</p><button class="btn" data-action="sync-retry">Retry / sign in</button></div>';
  });
  window.addEventListener('online', () => cloud.refresh());
  window.addEventListener('pagehide', () => cloud.flush());
  setInterval(() => { if (document.visibilityState === 'visible') cloud.refresh(); }, 30000);
})();
