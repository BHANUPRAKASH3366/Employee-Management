/*
 * Where the portal gets its data.
 *
 * Live mode — portal opened through the live server (start-portal.bat):
 *   loads /api/data and checks /api/status every few seconds. When the Excel
 *   workbook is saved, the server rebuilds the data and subscribers are told.
 *
 * Snapshot mode — index.html opened directly from disk:
 *   uses window.VCT_DATA from data/vct-data.js (rebuilt by the server or by
 *   update-data.bat).
 */
(function () {
  "use strict";
  const POLL_MS = 4000;
  const listeners = [];
  const state = { mode: "snapshot", version: null, connected: true, error: null, lastCheck: null };

  const canUseServer = /^https?:$/.test(location.protocol);

  async function getJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(path + " → " + res.status);
    return res.json();
  }

  async function load() {
    if (canUseServer) {
      try {
        const status = await getJson("api/status");
        const data = await getJson("api/data");
        state.mode = "live";
        state.version = status.version;
        state.error = status.error;
        state.lastCheck = new Date();
        startPolling();
        return data;
      } catch (e) {
        console.warn("Live server not available, using snapshot.", e);
      }
    }
    if (!window.VCT_DATA) throw new Error("Data file not found. Run update-data.bat or start-portal.bat.");
    state.mode = "snapshot";
    return window.VCT_DATA;
  }

  let timer = null;
  function startPolling() {
    if (timer) return;
    timer = setInterval(async () => {
      try {
        const status = await getJson("api/status");
        const wasDown = !state.connected;
        state.connected = true;
        state.lastCheck = new Date();
        const errChanged = status.error !== state.error;
        state.error = status.error;
        if (status.version && status.version !== state.version) {
          const data = await getJson("api/data");
          state.version = status.version;
          listeners.forEach((fn) => fn({ type: "data", data }));
        } else if (wasDown || errChanged) {
          listeners.forEach((fn) => fn({ type: "status" }));
        }
      } catch (e) {
        if (state.connected) {
          state.connected = false;
          listeners.forEach((fn) => fn({ type: "status" }));
        }
      }
    }, POLL_MS);
  }

  window.VCTDataSource = {
    load,
    state,
    onChange: (fn) => listeners.push(fn),
  };
})();
