import { Desktop } from '@wxcc-desktop/sdk';

// Initialize the Desktop SDK once
Desktop.config.init();

const TEMPLATE = document.createElement('template');
TEMPLATE.innerHTML = `
  <style>
    :host { display: block; font-family: system-ui, Segoe UI, Roboto, Arial, sans-serif; }
    .card {
      border: 1px solid var(--wxcc-border, #e2e2e2);
      border-radius: 6px;
      padding: 12px;
      background: var(--wxcc-bg, #fff);
      color: var(--wxcc-fg, #222);
    }
    h4 { margin: 0 0 8px 0; font-size: 14px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0; }
    dt { font-weight: 600; color: #555; }
    dd { margin: 0; color: #111; }
    .muted { color: #888; font-size: 12px; margin-top: 8px; }
  </style>
  <div class="card">
    <h4>Claim Values</h4>
    <dl>
      <dt>State</dt><dd id="state">—</dd>
      <dt>Carrier</dt><dd id="carrier">—</dd>
      <dt>CallType</dt><dd id="calltype">—</dd>
      <dt>ClaimNumber</dt><dd id="claimnumber">—</dd>
    </dl>
    <div class="muted" id="meta">Waiting for an active voice task…</div>
  </div>
`;

class CadVariablesWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).appendChild(TEMPLATE.content.cloneNode(true));
    this._interval = null;
  }

  connectedCallback() {
    // Poll as a safety net for event timing
    this._interval = setInterval(() => this.refresh(), 2000);

    // Also react to agent contact events quickly when available
    try {
      Desktop.agentContact?.addEventListener?.('*', () => this.refresh());
    } catch (e) {
      // ignore differences in SDK versions
    }

    this.refresh(); // initial
  }

  disconnectedCallback() {
    if (this._interval) clearInterval(this._interval);
  }

  async refresh() {
    try {
      const taskMap = await Desktop.actions.getTaskMap();
      const tasks = taskMap instanceof Map ? Array.from(taskMap.values()) : Object.values(taskMap || {});

      // Optional debug snapshot (remove if noisy)
      console.group('[cad-widget] task map snapshot');
      console.log('raw taskMap:', taskMap);
      console.log('values:', Array.isArray(tasks) ? tasks : []);
      console.groupEnd();

      if (!tasks.length) {
        this.renderCad({});
        this.$meta().textContent = 'Waiting for an active voice task…';
        return;
      }

      // Normalize common shapes for mediaType/state across SDK revisions
      const mediaTypeOf = (t) => {
        const fromTop = t?.mediaType;
        const fromInteraction = t?.interaction?.mediaType;
        const fromMediaObj = t?.media ? Object.values(t.media)[0]?.mediaType : undefined;
        return (fromTop || fromInteraction || fromMediaObj || '').toLowerCase();
      };
      const stateOf = (t) => (t?.state || t?.interaction?.state || '').toLowerCase();
      const isTelephony = (t) => mediaTypeOf(t) === 'telephony';
      const isActive = (t) => !['ended', 'wrapup-ended', 'disconnected'].includes(stateOf(t));

      // Prefer an active telephony task; otherwise any telephony task
      let voiceTask = tasks.find((t) => isTelephony(t) && isActive(t))
                    || tasks.find((t) => isTelephony(t));

      if (!voiceTask) {
        this.renderCad({});
        this.$meta().textContent = 'Waiting for an active voice task…';
        return;
      }

      // Pull CAD from the current valid Voice Task
      const rawCad =
        voiceTask?.cadVariables ||
        voiceTask?.interaction?.callAssociatedData ||
        voiceTask?.callAssociatedData ||
        {};

      const getVal = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v) ?? '';

      // Use the new PGR_* variables
      const data = {
        State:       getVal(rawCad['PGR_State']),
        Carrier:     getVal(rawCad['PGR_Carrier']),
        CallType:    getVal(rawCad['PGR_CallType']),    
        ClaimNumber: getVal(rawCad['PGR_ClaimNumber']),
      };

      this.renderCad(data);

      const id =
        voiceTask?.interactionId ||
        voiceTask?.id ||
        Object.keys(voiceTask?.media || {})[0] ||
        '(unknown)';

      this.$meta().textContent = `Interaction: ${id} · Last update: ${new Date().toLocaleTimeString()}`;

    } catch (err) {
      this.$meta().textContent = `Waiting for Desktop SDK… (${err?.message || err})`;
    }
  }

  renderCad({ State = '', Carrier = '', CallType = '', ClaimNumber = '' }) {
    this.$('state').textContent       = State || '—';
    this.$('carrier').textContent     = Carrier || '—';
    this.$('calltype').textContent    = CallType || '—';
    this.$('claimnumber').textContent = ClaimNumber || '—';
  }

  $(id)   { return this.shadowRoot.getElementById(id); }
  $meta() { return this.shadowRoot.getElementById('meta'); }
}

customElements.define('cad-variables-widget', CadVariablesWidget);
