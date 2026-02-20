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
      const taskMap = await Desktop.actions.getTaskMap(); // returns current tasks [1](https://developer.webex.com/blog/leveraging-the-webex-contact-center-agent-desktop-sdk-in-your-custom-widgets)

      // Normalize Map/Object
      const entries = taskMap instanceof Map ? Array.from(taskMap.values()) : Object.values(taskMap || {});

      // Pick an active voice call if present
      const voiceTask = entries.find(t =>
        (t?.mediaType === 'telephony' || t?.channelType === 'telephony' || t?.mediaType === 'voice') &&
        !['ended','wrapup-ended','disconnected'].includes((t?.state || '').toLowerCase())
      ) || null;

      if (!voiceTask) {
        this.renderCad({});
        this.$meta().textContent = 'Waiting for an active voice task…';
        return;
      }

      // CAD is present in the task payload; different SDK revs or payload shapes
      // may nest it differently. We check common locations defensively:
      const cad = voiceTask?.cadVariables
        || voiceTask?.cad
        || voiceTask?.variables
        || voiceTask?.attributes?.cad
        || {};

      // Extract your four globals
      const data = {
        PVState:        cad.PVState ?? cad['pvstate'] ?? '',
        PVCarrier:      cad.PVCarrier ?? cad['pvcarrier'] ?? '',
        PVCallType:     cad.PVCallType ?? cad['pvcalltype'] ?? '',
        PVClaimNumber:  cad.PVClaimNumber ?? cad['pvclaimnumber'] ?? '',
      };

      this.renderCad(data);

      const id = voiceTask?.interactionId || voiceTask?.id || '(unknown)';
      this.$meta().textContent = `Interaction: ${id} · Last update: ${new Date().toLocaleTimeString()}`;

    } catch (err) {
      // Non-fatal: show we’re alive even if SDK not ready yet
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
