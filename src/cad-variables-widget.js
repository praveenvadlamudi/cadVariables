import { Desktop } from '@wxcc-desktop/sdk';

// Initialize the Desktop SDK once
Desktop.config.init(); // per Cisco’s sample/blog [1](https://developer.webex.com/blog/leveraging-the-webex-contact-center-agent-desktop-sdk-in-your-custom-widgets)

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
    <h4>CAD (PV*)</h4>
    <dl>
      <dt>PVState</dt><dd id="pvstate">—</dd>
      <dt>PVCarrier</dt><dd id="pvcarrier">—</dd>
      <dt>PVCallType</dt><dd id="pvcalltype">—</dd>
      <dt>PVClaimNumber</dt><dd id="pvclaimnumber">—</dd>
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
    // Start a lightweight poll; reliable across all event timing cases.
    // (You can swap this for precise Desktop.agentContact events later.)
    this._interval = setInterval(() => this.refresh(), 2000);

    // Optional: also react promptly when any agent-contact events occur
    try {
      Desktop.agentContact?.addEventListener?.('*', () => this.refresh());
      // Depending on SDK version, you can register specific events as needed
      // e.g., 'hold', 'unhold', 'wrapup-started', 'wrapup-ended', etc. [1](https://developer.webex.com/blog/leveraging-the-webex-contact-center-agent-desktop-sdk-in-your-custom-widgets)
    } catch (e) {
      // Swallow if addEventListener signature differs
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
	
	console.group('[cad-widget] task map snapshot');
	console.log('raw taskMap:', taskMap);
	console.log('values:', Array.isArray(tasks) ? tasks : []);
	console.groupEnd();

    if (!tasks.length) {
      this.renderCad({});
      this.$meta().textContent = 'Waiting for an active voice task…';
      return;
    }

    // Helpers to normalize shapes seen in the SDK payloads
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

    // Pull CAD from the actual shape; flatten `.value` if present
    const rawCad =
      voiceTask?.cadVariables ||
      voiceTask?.interaction?.callAssociatedData ||
      voiceTask?.callAssociatedData ||
      {};

    const getVal = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v) ?? '';

    const data = {
      PVState:       getVal(rawCad.PVState),
      PVCarrier:     getVal(rawCad.PVCarrier),
      PVCallType:    getVal(rawCad.PVCallType),
      PVClaimNumber: getVal(rawCad.PVClaimNumber),
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

  renderCad({ PVState = '', PVCarrier = '', PVCallType = '', PVClaimNumber = '' }) {
    this.$('pvstate').textContent = PVState || '—';
    this.$('pvcarrier').textContent = PVCarrier || '—';
    this.$('pvcalltype').textContent = PVCallType || '—';
    this.$('pvclaimnumber').textContent = PVClaimNumber || '—';
  }

  $(id)     { return this.shadowRoot.getElementById(id); }
  $meta()   { return this.shadowRoot.getElementById('meta'); }
}

customElements.define('cad-variables-widget', CadVariablesWidget);
