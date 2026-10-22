/* MeshCore Activity Card — no dependencies, radio commands, or persistent storage. */
(() => {
  const TYPES = {
    ADVERTISEMENT: "adverts", NEW_CONTACT: "adverts", ADVERT_PATH: "adverts",
    STATUS_RESPONSE: "repeaters", TELEMETRY_RESPONSE: "repeaters", NEIGHBOURS_RESPONSE: "repeaters",
    LOGIN_SUCCESS: "repeaters", PATH_UPDATE: "repeaters", PATH_RESPONSE: "repeaters",
    BINARY_RESPONSE: "repeaters", DISCOVER_RESPONSE: "repeaters", CLI_REPLY: "repeaters",
    LOGIN_FAILED: "errors", ERROR: "errors", CONTACTS_FULL: "errors",
    RX_LOG_DATA: "packets", LOG_DATA: "packets", ACK: "packets", RAW_DATA: "packets", TRACE_DATA: "packets", CONTROL_DATA: "packets",
    CONNECTED: "connection", DISCONNECTED: "connection",
  };
  const LABELS = {
    ADVERTISEMENT: "Advert received", NEW_CONTACT: "Contact discovered", ADVERT_PATH: "Advert path",
    STATUS_RESPONSE: "Status response", TELEMETRY_RESPONSE: "Telemetry response",
    NEIGHBOURS_RESPONSE: "Neighbour response", LOGIN_SUCCESS: "Login accepted",
    LOGIN_FAILED: "Login failed", PATH_UPDATE: "Path updated", PATH_RESPONSE: "Path response",
    CONTACTS_FULL: "Companion contacts full", ERROR: "Companion error",
    RX_LOG_DATA: "Packet received", RAW_DATA: "Raw data", TRACE_DATA: "Trace response",
    CONNECTED: "Companion connected", DISCONNECTED: "Companion disconnected",
  };
  const typeName = value => String(value || "UNKNOWN").replace(/^EventType\./i, "").toUpperCase();
  const make = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (cls) el.className = cls;
    return el;
  };
  function classify(event) {
    const data = event.data || {};
    const type = event.event_type === "meshcore_raw_event" ? typeName(data.event_type)
      : event.event_type === "meshcore_connected" ? "CONNECTED" : "DISCONNECTED";
    const p = data.payload && typeof data.payload === "object" ? data.payload : {};
    // RX_LOG also contains chat packets. Hide known chat payload types (MeshCore
    // TXT_MSG=2, GRP_TXT=5, GRP_DATA=6); encrypted/unknown traffic remains visible.
    if (["CHANNEL_MSG_RECV", "CONTACT_MSG_RECV", "CHANNEL_DATA_RECV"].includes(type)) return null;
    const packetType = Number(p.payload_type ?? p.parsed?.payload_type ?? -1);
    if (type === "RX_LOG_DATA" && [2, 5, 6].includes(packetType)) return null;
    const category = type === "RX_LOG_DATA" && packetType === 4 ? "adverts" : TYPES[type];
    if (!category) return null; // Local battery/contact-table/queue ACK chatter isn't mesh RX.
    return {type, category, payload: p, data, event};
  }

  class MeshcoreActivityCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({mode: "open"});
      this._rows = [];
      this._unsubs = [];
      this._generation = 0;
      this._filter = "all";
      this._paused = false;
      this._status = "Waiting for Home Assistant";
      this._timer = null;
    }
    static getStubConfig() { return {title: "Mesh activity", max_events: 150, height: 480}; }
    setConfig(config) {
      const max = Number(config.max_events ?? 150), height = Number(config.height ?? 480);
      if (!Number.isInteger(max) || max < 10 || max > 500) throw new Error("max_events must be 10–500");
      if (!Number.isFinite(height) || height < 200 || height > 1200) throw new Error("height must be 200–1200");
      this._config = {...config, max_events: max, height};
      this._rows = this._rows.slice(0, max);
      this._render();
    }
    set hass(hass) {
      this._hass = hass;
      if (this.isConnected) this._subscribe();
    }
    getCardSize() { return Math.ceil((this._config?.height || 480) / 50) + 2; }
    connectedCallback() { this._subscribe(); this._render(); }
    disconnectedCallback() {
      this._stop();
      clearTimeout(this._timer);
      this._timer = null;
    }
    _stop() {
      this._generation++;
      for (const unsubscribe of this._unsubs.splice(0)) {
        try { Promise.resolve(unsubscribe()).catch(() => {}); } catch (_) { /* link closed */ }
      }
      this._connection = null;
    }
    async _subscribe() {
      const connection = this._hass?.connection;
      if (!connection || connection === this._connection) return;
      this._stop();
      this._connection = connection;
      const generation = this._generation;
      this._status = "Connecting to event feed…";
      this._schedule();
      const results = await Promise.allSettled(
        ["meshcore_raw_event", "meshcore_connected", "meshcore_disconnected"].map(
          name => connection.subscribeEvents(event => {
            if (generation === this._generation && this.isConnected) this._receive(event);
          }, name)
        )
      );
      if (generation !== this._generation || !this.isConnected) {
        for (const result of results) if (result.status === "fulfilled") {
          try { await result.value(); } catch (_) { /* closed */ }
        }
        return;
      }
      this._unsubs = results.filter(r => r.status === "fulfilled").map(r => r.value);
      const failed = results.find(r => r.status === "rejected");
      this._status = failed ? "Event subscription failed. Check HA user permissions; reload to retry."
        : "Listening · dashboard session only";
      this._schedule();
    }
    _receive(event) {
      if (this._paused || !this._config) return;
      const row = classify(event);
      if (!row || (this._config.entry_id && row.data.entry_id !== this._config.entry_id)) return;
      const seconds = Number(row.data.timestamp);
      row.time = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000)
        : new Date(event.time_fired || Date.now());
      const p = row.payload;
      row.name = p.adv_name || p.name || p.sender_name || p.contact?.adv_name || "";
      row.key = String(p.public_key || p.pubkey_prefix || p.pubkey_pre || p.contact?.public_key || "");
      if (!row.name && row.key && this._hass?.states) {
        for (const state of Object.values(this._hass.states)) {
          const attr = state.attributes || {};
          const key = String(attr.public_key || attr.pubkey_prefix || "");
          if (key && (key.startsWith(row.key) || row.key.startsWith(key)) && key.length >= 6) {
            row.name = attr.adv_name || attr.name || "";
            if (row.name) break;
          }
        }
      }
      try { row.raw = JSON.stringify(row.data, null, 2).slice(0, 12000); }
      catch (_) { row.raw = "Payload could not be displayed"; }
      // Retain bounded display data, not the original unbounded event object.
      row.name = String(row.name).slice(0, 160);
      row.key = row.key.slice(0, 128);
      row.payload = Object.fromEntries(["rssi", "snr", "path", "path_len", "payload_typename", "code_string", "reason"].filter(key => p[key] !== undefined).map(key => [key, typeof p[key] === "string" ? p[key].slice(0, 256) : p[key]]));
      row.payload.parsed = {path: p.parsed?.path?.slice(0, 256), path_len: p.parsed?.path_len};
      delete row.data; delete row.event;
      this._rows.unshift(row);
      this._rows.length = Math.min(this._rows.length, this._config.max_events);
      this._schedule();
    }
    _schedule() {
      if (this._timer !== null) return;
      this._timer = setTimeout(() => { this._timer = null; this._renderRows(); }, 200);
    }
    _render() {
      if (!this._config) return;
      const root = this.shadowRoot;
      root.replaceChildren();
      const style = make("style");
      style.textContent = `
        :host{display:block}ha-card{overflow:hidden}header{padding:18px 18px 10px;display:flex;gap:12px;align-items:center;justify-content:space-between}
        h2{font-size:20px;font-weight:500;margin:0;color:var(--primary-text-color)}.status{font-size:12px;color:var(--secondary-text-color);margin-top:5px}
        .controls{display:flex;gap:8px;padding:0 18px 12px;flex-wrap:wrap}button,select{font:inherit;font-size:13px;color:var(--primary-text-color);background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:8px;padding:7px 10px;cursor:pointer}
        button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--primary-color)}.feed{height:${this._config.height}px;overflow:auto;padding:0 18px 12px;box-sizing:border-box}
        details{border-top:1px solid var(--divider-color);padding:10px 0}summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:72px 1fr;gap:10px}summary::-webkit-details-marker{display:none}
        time{font:12px monospace;color:var(--secondary-text-color);padding-top:3px}.tag{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--primary-color)}
        .errors .tag{color:var(--error-color,#db4437)}.adverts .tag{color:var(--success-color,#3e9d5c)}.title{font-size:14px;color:var(--primary-text-color);overflow-wrap:anywhere;margin:3px 0}.meta{font-size:12px;line-height:1.7;color:var(--secondary-text-color);overflow-wrap:anywhere}
        pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.5;background:var(--secondary-background-color);padding:10px;border-radius:6px;max-height:260px;overflow:auto;color:var(--primary-text-color)}
        .empty{padding:42px 8px;color:var(--secondary-text-color);font-size:14px;line-height:1.6}.foot{padding:8px 18px 12px;font-size:11px;color:var(--secondary-text-color)}
      `;
      const card = make("ha-card"), header = make("header"), heading = make("div");
      heading.append(make("h2", this._config.title || "Mesh activity"));
      this._statusEl = make("div", this._status, "status");
      heading.append(this._statusEl); header.append(heading);
      const controls = make("div", undefined, "controls"), select = make("select");
      select.setAttribute("aria-label", "Activity filter");
      for (const [value, label] of [["all","All diagnostics"],["adverts","Adverts"],["repeaters","Repeater responses"],["packets","Packets"],["errors","Errors"],["connection","Connection"]]) {
        const option = make("option", label); option.value = value; select.append(option);
      }
      select.value = this._filter;
      select.addEventListener("change", () => { this._filter = select.value; this._renderRows(); });
      const pause = make("button", this._paused ? "Resume" : "Pause");
      pause.addEventListener("click", () => {
        this._paused = !this._paused; pause.textContent = this._paused ? "Resume" : "Pause"; this._renderRows();
      });
      const clear = make("button", "Clear");
      clear.addEventListener("click", () => { this._rows = []; this._renderRows(); });
      controls.append(select, pause, clear);
      this._feed = make("div", undefined, "feed");
      this._feed.setAttribute("aria-label", "Mesh diagnostic activity");
      this._foot = make("div", undefined, "foot");
      card.append(header, controls, this._feed, this._foot); root.append(style, card);
      this._renderRows();
    }
    _renderRows() {
      if (!this._feed) return;
      this._statusEl.textContent = this._paused ? "Paused · new events are discarded" : this._status;
      // Preserve expanded rows and scroll position while new packets arrive.
      const open = new Set([...this._feed.querySelectorAll("details[open]")].map(el => el._row));
      const scroll = this._feed.scrollTop;
      const previousHeight = this._feed.scrollHeight;
      this._feed.replaceChildren();
      const rows = this._rows.filter(row => this._filter === "all" || row.category === this._filter);
      for (const row of rows) {
        const details = make("details", undefined, row.category); details._row = row; details.open = open.has(row);
        const summary = make("summary"), text = make("div"), p = row.payload;
        summary.append(make("time", row.time.toLocaleTimeString([], {hour12:false})));
        text.append(make("div", row.category, "tag"));
        text.append(make("div", [LABELS[row.type] || row.type, row.name || row.key.slice(0,12)].filter(Boolean).join(" · "), "title"));
        const parsed = p.parsed || {}, meta = [];
        if (p.rssi !== undefined) meta.push(`RSSI ${p.rssi} dBm`);
        if (p.snr !== undefined) meta.push(`SNR ${p.snr} dB`);
        const path = p.path ?? parsed.path;
        const hops = p.path_len ?? parsed.path_len;
        if (path) meta.push(`Path ${String(path).toUpperCase()}`);
        if (hops !== undefined) meta.push(`${hops} hops`);
        if (p.payload_typename) meta.push(p.payload_typename);
        if (!row.name && !row.key && row.type === "RX_LOG_DATA") meta.push("Sender not identified");
        if (p.code_string || p.reason) meta.push(String(p.code_string || p.reason));
        text.append(make("div", meta.join(" · ") || "Expand for event details", "meta"));
        summary.append(text); details.append(summary, make("pre", row.raw)); this._feed.append(details);
      }
      if (!rows.length) this._feed.append(make("div", "Waiting for incoming activity. Adverts and repeater responses appear here as the companion receives them. Chat and routine local query replies are hidden.", "empty"));
      this._foot.textContent = `${rows.length} shown · ${this._rows.length}/${this._config.max_events} retained · newest first · expand a row for raw data`;
      this._feed.scrollTop = scroll > 0 ? scroll + Math.max(0, this._feed.scrollHeight - previousHeight) : 0;
    }
  }
  if (!customElements.get("meshcore-activity-card")) customElements.define("meshcore-activity-card", MeshcoreActivityCard);
  window.customCards = window.customCards || [];
  if (!window.customCards.some(card => card.type === "meshcore-activity-card")) window.customCards.push({
    type:"meshcore-activity-card", name:"MeshCore Activity", description:"Live adverts, repeater responses and diagnostic packets."
  });
})();
