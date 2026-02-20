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
    h4 { margin: 0 0 10px 0; font-size: 14px; }
    form { display: grid; gap: 10px; }
    label { font-size: 12px; color: #444; display: block; margin-bottom: 4px; }
    select, input[type="text"] {
      width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px;
    }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .actions { display: flex; gap: 8px; margin-top: 6px; }
    button {
      appearance: none; border: 0; border-radius: 4px; padding: 8px 12px;
      background: #0b5fff; color: #fff; font-weight: 600; cursor: pointer;
    }
    button[disabled] { background: #c7d3ff; color: #fff; cursor: not-allowed; }
    .muted { color: #888; font-size: 12px; margin-top: 8px; }
    .success { color: #176f2c; }
    .error { color: #a42828; }
  </style>

  <div class="card">
    <h4>Enter Claim Values</h4>
    <form id="cadForm">
      <div class="row">
        <div>
          <label for="state">State (PGR_State)</label>
          <select id="state">
            <option value="">— Select —</option>
          </select>
        </div>
        <div>
          <label for="calltype">Call Type (PGR_CallType)</label>
          <select id="calltype">
            <option value="">— Select —</option>
          </select>
        </div>
      </div>

      <div>
        <label for="carrier">Carrier (PGR_Carrier)</label>
        <select id="carrier">
          <option value="">— Select —</option>
        </select>
      </div>

      <div>
        <label for="claimnumber">Claim Number (PGR_ClaimNumber) <span class="muted">(required)</span></label>
        <input type="text" id="claimnumber" placeholder="Enter claim number…" />
      </div>

      <div class="actions">
        <button id="submitBtn" type="submit" disabled>Submit</button>
      </div>
    </form>

    <div class="muted" id="meta">Waiting for an active voice task…</div>
  </div>
`;

class CadVariablesWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).appendChild(TEMPLATE.content.cloneNode(true));

    // DOM refs
    this.$form = this.shadowRoot.getElementById('cadForm');
    this.$state = this.shadowRoot.getElementById('state');
    this.$carrier = this.shadowRoot.getElementById('carrier');
    this.$calltype = this.shadowRoot.getElementById('calltype');
    this.$claim = this.shadowRoot.getElementById('claimnumber');
    this.$submit = this.shadowRoot.getElementById('submitBtn');

    // Fill dropdowns
    this.populateDropdown(this.$state, STATES);
    this.populateDropdown(this.$carrier, CARRIERS);
    this.populateDropdown(this.$calltype, CALL_TYPES);

    // Live validation for required claim number
    this.$claim.addEventListener('input', () => {
      this.$submit.disabled = this.$claim.value.trim().length === 0;
    });

    // Submit handler
    this.$form.addEventListener('submit', (e) => this.handleSubmit(e));

    // Poll status (interaction availability)
    this._interval = null;
  }

  connectedCallback() {
    this._interval = setInterval(() => this.refreshMeta(), 2000);
    this.refreshMeta(); // initial

    // Optional: react to agent-contact events quickly
    try {
      Desktop.agentContact?.addEventListener?.('*', () => this.refreshMeta());
    } catch {}
  }

  disconnectedCallback() {
    if (this._interval) clearInterval(this._interval);
  }

  populateDropdown(selectEl, items) {
    const frag = document.createDocumentFragment();
    for (const item of items) {
      const opt = document.createElement('option');
      if (typeof item === 'string') {
        opt.value = item;
        opt.textContent = item;
      } else {
        opt.value = item.value ?? item.label;
        opt.textContent = item.label ?? item.value;
      }
      frag.appendChild(opt);
    }
    selectEl.appendChild(frag);
  }

  isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v || '');
  }

  /**
   * Returns { id, task } for a telephony task (active preferred).
   * Picks the UUID from the map KEY first, then common fallbacks.
   * Logs candidate IDs once so you can verify which one is chosen.
   */
  async getVoiceTaskEntry() {
    const taskMap = await Desktop.actions.getTaskMap();

    const entries = taskMap instanceof Map
      ? Array.from(taskMap.entries())                // [id, task]
      : Object.entries(taskMap || {});               // [id, task]

    const toMediaType = (t) => {
      const fromTop = t?.mediaType;
      const fromInteraction = t?.interaction?.mediaType;
      const fromMediaObj = t?.media ? Object.values(t.media)[0]?.mediaType : undefined;
      return (fromTop || fromInteraction || fromMediaObj || '').toLowerCase();
    };
    const toState = (t) => (t?.state || t?.interaction?.state || '').toLowerCase();
    const isTelephony = (t) => toMediaType(t) === 'telephony';
    const isActive = (t) => !['ended', 'wrapup-ended', 'disconnected'].includes(toState(t));

    const active = entries.find(([_, t]) => isTelephony(t) && isActive(t));
    const anyTel = active || entries.find(([_, t]) => isTelephony(t));
    if (!anyTel) return null;

    const [key, task] = anyTel;

    // Build a candidate list; choose the first valid UUID
    const candidates = [
      key,                                    // map key is usually the interaction id (UUID)
      task?.interactionId,
      task?.interaction?.interactionId,
      task?.mainInteractionId,
      task?.parentInteractionId,
      task?.id,
      task?.interaction?.id,
      Object.keys(task?.media || {})[0],
    ].filter(Boolean);

    const chosen = candidates.find((c) => this.isUuid(c));

    // DEBUG once: which IDs did we see?
    try {
      if (!this.__loggedOnce) {
        console.debug('[cad-widget] interactionId candidates:', candidates, 'chosen:', chosen);
        this.__loggedOnce = true;
      }
    } catch {}

    return chosen ? { id: chosen, task } : null;
  }

  async refreshMeta() {
    try {
      const entry = await this.getVoiceTaskEntry();
      if (!entry) {
        this.$meta().textContent = 'Waiting for an active voice task…';
        return;
      }
      this.$meta().textContent = `Interaction: ${entry.id}`;
    } catch (err) {
      this.$meta().textContent = `Waiting for Desktop SDK… (${err?.message || err})`;
    }
  }

  async handleSubmit(e) {
    e.preventDefault();
    this.$submit.disabled = true;

    try {
      const entry = await this.getVoiceTaskEntry();
      if (!entry) {
        this.setStatus('No active telephony interaction was found. Please try again when on a call.', 'error');
        this.$submit.disabled = this.$claim.value.trim().length === 0;
        return;
      }

      const { id: interactionId } = entry;
      if (!this.isUuid(interactionId)) {
        this.setStatus('Failed to save CAD: interactionId is not a valid UUID', 'error');
        this.$submit.disabled = this.$claim.value.trim().length === 0;
        return;
      }

      // Build payload only with provided values
      const payload = {};
      const state    = this.$state.value.trim();
      const carrier  = this.$carrier.value.trim();
      const calltype = this.$calltype.value.trim();
      const claim    = this.$claim.value.trim();

      if (!claim) {
        this.setStatus('Claim Number is required.', 'error');
        this.$submit.disabled = false;
        return;
      }

      if (state)    payload['PGR_State']        = state;
      if (carrier)  payload['PGR_Carrier']      = carrier;
      if (calltype) payload['PGR_CallType']     = calltype;
      payload['PGR_ClaimNumber']                = claim; // required

      // Desktop.dialer.updateCadVariables({ interactionId, data: { attributes: { ... } } })
	  const cadVarsUpdated = await Desktop.dialer.updateCadVariables({
        interactionId: interactionId,
        data: {
          attributes: {
            PGR_ClaimNumber: '12341234',
          },
        },
      });
	  
	  console.log('CadVarsUpdated value: ' + JSON.stringify(cadVarsUpdated));
	  
      //await Desktop.dialer.updateCadVariables({
      //  interactionId: interactionId,
      //  data: { 
	//	  attributes: payload }
    //  }); 
	  
	  // ref: WebexSamples desktop-js-sdk-sample (sa-ds-sdk.js) [1](https://dev.to/code_2/building-and-deploying-a-custom-site-using-github-actions-and-github-pages-3fjf)

      this.setStatus(`Saved CAD for interaction ${interactionId} at ${new Date().toLocaleTimeString()}.`, 'success');

    } catch (err) {
      this.setStatus(`Failed to save CAD: ${err?.message || err}`, 'error');
    } finally {
      // Re-enable submit if claim number still present (so agent can adjust)
      this.$submit.disabled = this.$claim.value.trim().length === 0;
    }
  }

  setStatus(msg, type = 'muted') {
    const el = this.$meta();
    el.classList.remove('success', 'error');
    if (type !== 'muted') el.classList.add(type);
    el.textContent = msg;
  }

  $meta() { return this.shadowRoot.getElementById('meta'); }
}

customElements.define('cad-variables-widget', CadVariablesWidget);

/* ---------- Static data ---------- */

const STATES = [
  "Alabama (AL)","Alaska (AK)","Arizona (AZ)","Arkansas (AR)","California (CA)","Colorado (CO)",
  "Connecticut (CT)","Delaware (DE)","District of Columbia (DC)","Florida (FL)","Georgia (GA)","Hawaii (HI)",
  "Idaho (ID)","Illinois (IL)","Indiana (IN)","Iowa (IA)","Kansas (KS)","Kentucky (KY)","Louisiana (LA)","Maine (ME)",
  "Maryland (MD)","Massachusetts (MA)","Michigan (MI)","Minnesota (MN)","Mississippi (MS)","Missouri (MO)","Montana (MT)",
  "Nebraska (NE)","Nevada (NV)","New Hampshire (NH)","New Jersey (NJ)","New Mexico (NM)","New York (NY)",
  "North Carolina (NC)","North Dakota (ND)","Ohio (OH)","Oklahoma (OK)","Oregon (OR)","Pennsylvania (PA)",
  "Puerto Rico (PR)","Rhode Island (RI)","South Carolina (SC)","South Dakota (SD)","Tennessee (TN)","Texas (TX)",
  "Utah (UT)","Vermont (VT)","Virginia (VA)","Washington (WA)","West Virginia (WV)","Wisconsin (WI)","Wyoming (WY)"
];

const CALL_TYPES = [
  "Inbound",
  "Initial Claim Filing",
  "Follow-Up (Coverage Status)",
  "Follow-Up (Liability Status)"
];

// … keep your full CARRIERS array here (unchanged)
const CARRIERS = [
  "1st Auto & Casualty",
  "1st Chicago Insurance",
  "21st Century",
  // ... (list truncated for brevity in this snippet)
  "Zipcar",
  "Zurich Insurance"
];
