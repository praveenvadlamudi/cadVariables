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
          <label for="state">Insurance State</label>
          <select id="state">
            <option value="">— Select —</option>
          </select>
        </div>
        <div>
          <label for="calltype">Call Type</label>
          <select id="calltype">
            <option value="">— Select —</option>
          </select>
        </div>
      </div>

      <div>
        <label for="carrier">Insurance Name</label>
        <select id="carrier">
          <option value="">— Select —</option>
        </select>
      </div>

      <div>
        <label for="claimnumber">Afni Claim Number <span class="muted">(required)</span></label>
        <input type="text" id="claimnumber" placeholder="Enter Afni claim number…" />
      </div>

      <div class="actions">
        <!-- IMPORTANT: type="button" to avoid form submit bubbling -->
        <button id="submitBtn" type="button" disabled>Submit</button>
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

    // IMPORTANT: Use a click handler on the button; do NOT listen for form submit
    this.$submit.addEventListener('click', (e) => this.handleSubmit(e));

    // Prefill guard (avoid overwriting agent keystrokes repeatedly)
    this._prefilledOnce = false;

    // Poll status (interaction availability)
    this._interval = null;
  }

  connectedCallback() {
    this._interval = setInterval(() => this.refreshMeta(), 2000);
    this.refreshMeta(); // initial
    this.prefillFromCad(); // try prefill right away

    // Optional: react to agent-contact events quickly
    try {
      Desktop.agentContact?.addEventListener?.('*', () => {
        this.refreshMeta();
        this.prefillFromCad();
      });
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
      // Also attempt prefill if available
      this.prefillFromCad();
    } catch (err) {
      this.$meta().textContent = `Waiting for Desktop SDK… (${err?.message || err})`;
    }
  }

  /**
   * Prefill Claim Number from PGR_ClaimNumber Global if available.
   * - Reads CAD from task.cadVariables OR interaction.callAssociatedData OR callAssociatedData
   * - Supports both plain string and { value: ... } forms
   * - Runs only once (won’t overwrite agent’s typing)
   */
  async prefillFromCad() {
    try {
      if (this._prefilledOnce) return;

      const entry = await this.getVoiceTaskEntry();
      if (!entry) return;

      const t = entry.task;
      const rawCad =
        t?.cadVariables ||
        t?.interaction?.callAssociatedData ||
        t?.callAssociatedData ||
        {};

      const v = rawCad?.PGR_ClaimNumber;
      const claim = (v && typeof v === 'object' && 'value' in v) ? v.value : v;

      if (claim && !this.$claim.value) {
        this.$claim.value = String(claim);
        this.$submit.disabled = this.$claim.value.trim().length === 0;
        this._prefilledOnce = true;
      }
    } catch {
      this.setStatus(`Failed to pre populate: ${err?.message || err}`, 'error');
    }
  }

  async handleSubmit(e) {
    // submit on button click
    e?.preventDefault?.();
    e?.stopPropagation?.();

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
      let state    = this.$state.value.trim();
      let carrier  = this.$carrier.value.trim();
      let calltype = this.$calltype.value.trim();
      let claim    = this.$claim.value.trim();

      if (!claim) {
        this.setStatus('Claim Number is required.', 'error');
        this.$submit.disabled = false;
        return;
      }

      if (state)    payload['PGR_State']        = state;
      if (carrier)  payload['PGR_Carrier']      = carrier;
      if (calltype) payload['PGR_CallType']     = calltype;
      payload['PGR_ClaimNumber']                = claim; // required

      // populate empty values if not selected any drop down value
      if (!state)    state = ' ';
      if (!carrier)  carrier = ' ';
      if (!calltype) calltype = ' ';

      // Desktop.dialer.updateCadVariables({ interactionId, data: { attributes: { ... } } })
      const cadVarsUpdated = await Desktop.dialer.updateCadVariables({
        interactionId,
        data: {
          attributes: {
            PGR_ClaimNumber: claim,
            PGR_CallType: calltype,
            PGR_Carrier: carrier,
            PGR_State: state,
          },
        },
      });

      console.log('CadVarsUpdated value:', cadVarsUpdated);
      this.setStatus(`Saved CAD for interaction ${interactionId} at ${new Date().toLocaleTimeString()}.`, 'success');

    } catch (err) {
      this.setStatus(`Failed to save CAD: ${err?.message || err}`, 'error');
    } finally {
      // Re-enable submit if claim number still present
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

const CARRIERS = [
  "1st Auto & Casualty",
  "1st Chicago Insurance",
  "21st Century",
  "21st Century General Agency Insurance",
  "3PD",
  "A Central Insurance",
  "AAA - Auto Club Enterprises",
  "AARP/THE HARTFORD",
  "ABC Insurance (Direct Auto)",
  "Acadia Insurance",
  "ACC - California Insurance",
  "ACCC Insurance Co./American Century",
  "Acceptance Indemnity Insurance",
  "Acceptance Insurance",
  "Access General (Receivership)",
  "Access Insurance",
  "Accredited Specialty Insurance",
  "Accurate Auto Insurance",
  "ACE American/Chubb",
  "Acuity Insurance",
  "Adirondack/National General",
  "Admiral Insurance",
  "Advanced Car Rental",
  "Advantage Auto Insurance",
  "Advantage Care",
  "Advantage Rent-a-Car",
  "AEGIS Security Insurance (Handles Anchor Claims)",
  "AFA Claim Services (now part of BlueFire Insurance)",
  "Ag Workers Insurance",
  "Aggressive Insurance",
  "AGI Insurance Group/Statewide Claims Service",
  "AGIA Insurance",
  "AIC - Agency Insurance Company",
  "AIG/National Union",
  "Alamo Insurance Group",
  "Alaska National",
  "Alfa Alliance Insurance Company",
  "Alfa/Alfa Vision/Trexis",
  "ALINSCO Insurance",
  "All America Insurance",
  "Alliance United",
  "Allianz",
  "Allianz Global Corporate & Specialty (AGCS)",
  "Allied Insurance (part of Nationwide)",
  "Allstate",
  "Alpha Property & Casualty",
  "Amalgamated",
  "AMCO (part of Allied/Nationwide)",
  "Assurance America",
  "American Alliance",
  "American Alternative - AUTO",
  "American Automobile Insurance Company",
  "American Bankers Insurance of FLA",
  "American Commerce (MAPFRE)",
  "American Family",
  "American Farmers & Ranchers Mutual Inc Co",
  "American Freedom Insurance",
  "American Heartland",
  "American Heritage",
  "American Independent (aka Good2Go Insurance)",
  "American Inter-Fidelity Exchange",
  "American Millennium Insurance",
  "American Modern Insurance",
  "American National (AnPac)",
  "American Reliable",
  "American Risk",
  "American Road Insurance Company",
  "American Southern Insurance/ American Safety",
  "American Southwest Ins. Managers (AMWINS)",
  "American Standard Ins. (aka American Family- High Risk)",
  "American Transit Ins.",
  "American Underwriters Insurance Co.",
  "American West Ins.S",
  "Ameriprise - now CONNECT by American Family",
  "Amerisure Mutual",
  "Amica",
  "AMSHIELD INSURANCE CO",
  "AMTRUST North America",
  "AmWINS Specialty Auto",
  "Anchor General/ Cost U Less Claims/ Pac Star",
  "Andover Insurance",
  "Apparent Insurance",
  "ARBELLA Mutual Insurance",
  "Arch Insurance",
  "Argonaut Insurance Co.",
  "ARI Insurance Companies",
  "Artisan & Truckers (Progressive)",
  "Ascendant Commercial Ins.",
  "Aspen MGA",
  "Aspire General Insurance",
  "Assurant Group",
  "Atlantic Casualty Insurance",
  "Atlantic States Insurance/ Donegal Group",
  "Augusta Mutual Insurance Company",
  "Austin Mutual",
  "Auto Club South",
  "Auto-Owners Insurance",
  "Avatar Insurance",
  "AVIS / PV Holding ",
  "Avis Car Rental",
  "Aviva Insurance (Canada)",
  "Axis Surplus Insurance",
  "Badger Mutual Ins. Co.",
  "Bankers Standard (ACE USA)",
  "Bear River Insurance",
  "Benchmark Insurance",
  "Berkley North Pacific",
  "Berkley Prime Transportation",
  "Berkley Specialty",
  "Berkley SW",
  "Berkshire Hathaway Guard",
  "Bitco Insurance Company",
  "Bluefire Insurance",
  "Brethren Mutual Ins Company",
  "Bristol West",
  "Broadspire",
  "Broadspire for Uber",
  "Brotherhood Mutual Insurance Company",
  "Buckle Insurance",
  "Budget/Avis",
  "Builder's Insurance Group",
  "California Casualty",
  "Canal Insurance Company",
  "Carolina Casualty Ins",
  "Casualty Underwriters Insurance",
  "Celina Insurance Group",
  "CEM Insurance Company",
  "Central Insurance Companies",
  "Century National Insurance Co.",
  "Certainly Insurance",
  "Christian Brothers Services",
  "Chubb Insurance/ACE American",
  "Church Mutual Insurance",
  "CIG / Capital Insurance Group",
  "CIMARRON INSURANCE COMPANY, INC",
  "Cincinnati Insurance (Cincinnati Financial)",
  "Citizens / Hanover",
  "Citizens Property / Citizens Daily",
  "Clear Blue/Clear Cover Insurance Company/Littleton Group",
  "Clear Spring Property & Casualty",
  "CLEARCOVER",
  "CNA Insurance",
  "Coast National Ins (Part Of Bristol West)",
  "Colonial County Mutual",
  "Colony Specialty Insurance",
  "Commerce /Mapfre",
  "Commercial Alliance Ins (CAIC)",
  "Commercial Hirecar Insurance Company",
  "Commonwealth Casualty",
  "Companion Property & Casualty",
  "Concord Group Insurance",
  "CONNECT By American Family",
  "Connect Insurance",
  "Consumers County Mutual Insurance",
  "Consumers Insurance",
  "Continental Western Group",
  "Corepointe",
  "Cornerstone National Ins",
  "Country Financial",
  "Country-Wide Insurance",
  "Crawford & Company (TESLA)",
  "Crown Captive Insurance",
  "Crum & Forster Specialty Insurance",
  "Crusader Insurance",
  "CSAA",
  "CSE Insurance Group",
  "Cumberland Insurance Group",
  "CUNA Mutual",
  "CURE Auto Ins",
  "Cypress Insurance Group",
  "Dairyland Insurance",
  "David Morse & Associates-DMA",
  "Deep South Insurance",
  "Delphi Casualty Company",
  "Depositors Ins (Part Of Allied/Nationwide)",
  "Direct Auto Insurance",
  "Direct General (National General)",
  "Discovery Insurance",
  "Dollar/Thrifty Car Rental (Hertz)",
  "Donegal Insurance Group",
  "DoorDash",
  "DRIVE Insurance",
  "DTRIC Insurance Company",
  "Echelon Property & Casualty Insurance Co",
  "Economical Mutual Insurance",
  "ELCO (formerly) now Rental Claims Services-ALAMO",
  "Electric Insurance",
  "Elephant Auto Insurance",
  "Embark General",
  "EMC Insurance",
  "Empire Fire and Marine Insurance",
  "Empower (formerly)",
  "Encompass Insurance",
  "Encova",
  "Enterprise Fleet Management",
  "Enterprise Rental (EAN Holdings)",
  "Equity Insurance",
  "Erie Insurance",
  "ESIS",
  "Essentia Insurance Company / Hagerty",
  "Esurance - merged w/ Allstate & National General",
  "Ethio-American Ins",
  "Everest Indemnity Insurance",
  "Everett Cash Mutual",
  "Explorer Insurance/North American Risk Services",
  "E-Z Rent A Car",
  "Falcon Insurance Co",
  "Falls Lake Insurance Company",
  "Farm Bureau (All States)",
  "Farm Family Insurance",
  "Farmers",
  "Farmers & Mechanics Insurance Company",
  "Farmers Alliance",
  "Farmers Mutual Hail Insurance",
  "Farmers Mutual-Nebraska & South Dakota only",
  "Farmers Property and Casualty (previously Metlife)",
  "FCCI Insurance Group",
  "Fed Ex (ARC Claims Management)",
  "Federated Mutual Insurance",
  "Fenix Gateway - DMA CLAIMS",
  "FFIC/ Fireman's Fund",
  "Financial Indemnity",
  "Finders Insurance",
  "Fireman's Fund",
  "First Acceptance Insurance (was DIRECT AUTO)",
  "First American Property & Casualty",
  "First Chicago Insurance",
  "First Insurance Company of Hawaii",
  "First National Insurance Group",
  "Fleet Response",
  "Foremost",
  "Founders",
  "Frankenmuth Ins.",
  "Franklin Mutual Insurance",
  "Fred Loya Insurance",
  "Fremont Insurance",
  "GAINSCO",
  "Garrison Property And Casualty (USAA)",
  "GEICO",
  "General Casualty",
  "Geneva Insurance",
  "Germania Insurance",
  "Germantown Mutual Insurance",
  "GetARound Inc",
  "Gig Car Share",
  "Glacier Insurance Company",
  "GMAC Insurance / NGIC",
  "Go Auto Insurance",
  "Good2Go Auto",
  "Goodville Mutual Casualty",
  "Granada Insurance",
  "Grand River Insurance",
  "Grange Insurance",
  "Great American Insurance",
  "Great Divide Insurance",
  "Great Lakes Casualty",
  "Great Midwest Insurance",
  "Great West Casualty",
  "Green Mountain Ins.",
  "Greenpath Insurance",
  "Greenwich Insurance Company",
  "Grinnell Mutual Reinsurance Co.",
  "Guard Insurance (Berkshire Hathaway)",
  "GuideOne Insurance",
  "Hagerty Insurance",
  "Halifax Mutual Insurance Company",
  "Hallmark Insurance",
  "Hanover",
  "Hanover Fire and Casualty",
  "Harbor Insurance Company",
  "Harco/Harco National",
  "Harford Mutual",
  "Harleysville Insurance",
  "Hartford/AARP",
  "Hastings Mutual",
  "Haulers Insurance",
  "Hawaiian Insurance and Guaranty Co",
  "Helmsman Management Services",
  "Help Point Claim Services (HPCS)",
  "HERC RENTAL",
  "Hereford Insurance",
  "Heritage Insurance",
  "Heritage Mutual Insurance",
  "Heritage Property and Casualty",
  "Hertz First Report / ESIS",
  "Highpoint Insurance (Plymouth Rock)",
  "Hippo",
  "HIROAD (HI ROAD)",
  "Hochheim Prairie Farm Mutual",
  "Home Owners / Auto Owners Insurance",
  "Home State County Mutual",
  "Horace Mann Insurance",
  "Hudson Insurance Group",
  "Hugo Insurance (FIRST ACCEPTANCE)",
  "IAT Specialty",
  "IDS Property & Casualty Insurance",
  "Illinois Casualty Company",
  "Imperial Fire & Casualty",
  "IMT Insurance",
  "Indiana Farmers Mutual",
  "Infinity Insurance",
  "Insurance Co of the State of PA (AIG)",
  "Insurance Company Of The South",
  "Integon National Insurance",
  "Integrated General Insurance",
  "Integrity Property & Casualty",
  "Interstate Bankers Casualty",
  "James River Insurance",
  "JB Hunt Transportation",
  "Kemper",
  "Kentucky Farm Bureau",
  "Kentucky National Ins",
  "Key Insurance Company",
  "Kingstone Insurance",
  "Kinsale Insurance Company",
  "KnightBrook Insurance Company",
  "Lancer Insurance",
  "Lemonade Insurance",
  "Lexington Insurance",
  "Liberty Mutual Insurance Group",
  "Lighthouse Casualty",
  "Lonestar",
  "Loya Casualty Insurance",
  "Lyft Claims",
  "Lyndon Southern Insurance",
  "Madison Mutual Insurance",
  "Magnum Insurance",
  "Maidstone Insurance (LIQUIDATION)",
  "MAIF / Maryland Auto Insurance",
  "Main Street America / MSA Group",
  "Mapfre Insurance",
  "Markel Insurance",
  "Maxum Specialty Insurance Group",
  "MAYA Assurance Company",
  "Meadowbrook Insurance (AmeriTrust Group)",
  "Meemic Insurance",
  "Mendota Insurance",
  "MENNONITE MUTUAL INSURANCE",
  "Merchants Mutual Ins",
  "Mercury Insurance",
  "Meridian Citizens Mutual Insurance",
  "Metromile",
  "Michigan Insurance Company",
  "Michigan Millers Mutual Ins",
  "Mid-Century Insurance (Farmers)",
  "Mid-Continent Group",
  "Middlesex Insurance",
  "Midwest Family Mutual",
  "MMG Insurance",
  "Mobilitas Insurance Company",
  "Motor Club Insurance",
  "Motorist Mutual / Encova",
  "Mount Morris Mutual Insurance Company",
  "MSIG / Mitsui Sumitomo Insurance Group",
  "Municipal Mutual Insurance Company of WV",
  "Mutual Benefit",
  "Mutual of Enumclaw",
  "Mutual Of Wausau",
  "National Casualty aka Scottsdale Ins.",
  "National Continental Ins Co",
  "National Farmers Union",
  "National Fire & Marine Ins",
  "National General Insurance",
  "National Grange Mutual",
  "National Grid",
  "National Heritage Insurance",
  "National Indemnity",
  "National Independent Truckers Ins",
  "National Insurance",
  "National Interstate",
  "National Liability & Fire",
  "National Lloyds Insurance",
  "National Rent A Car",
  "National Specialty",
  "National Union & Fire (AIG)",
  "National Unity",
  "Nations Insurance",
  "Nationwide Agribusiness",
  "Nationwide Insurance",
  "Navigators Insurance",
  "Nevada General Insurance Company",
  "New Hampshire Insurance Company",
  "New Jersey Manufacturers- NJM Insurance",
  "New York Central Mutual (NYCM)",
  "New York Marine and General",
  "NGM Claims",
  "NGM Insurance Claims",
  "Nodak Insurance Company",
  "Norfolk & Dedham Group",
  "North American Risk/NARS",
  "North Bay Auto Insurance",
  "Northern Mutual Insurance Co.",
  "Northern Plains",
  "Northland Insurance",
  "Nova Casualty Co",
  "NTA General Insurance",
  "Obsidian Specialty",
  "Occidental Fire & Casualty",
  "Ocean Harbor Casualty",
  "Ohio Casualty",
  "Ohio Indemnity",
  "Ohio Mutual Insurance",
  "Old American County Mutual (TPA)",
  "Old American Indemnity Co",
  "Old Dominion Insurance Company",
  "Old Republic Insurance",
  "One Beacon Insurance Group",
  "OOIDA Insurance",
  "Oregon Mutual Insurance",
  "Oxford Auto Insurance",
  "Pacific Insurance Company LTD",
  "Pacific Specialty",
  "Park Insurance (LIQUIDATION)",
  "Partners Mutual",
  "Patriot General Insurance",
  "Patriot Insurance",
  "Payless Car Rental",
  "Peachtree Casualty",
  "Peak Property & Casualty",
  "Pearl Holdings",
  "Peerless Insurance",
  "Pekin Insurance",
  "PEMCO Insurance",
  "Peninsula Insurance",
  "Penn America Ins Co",
  "Penn National Insurance",
  "Pennsylvania Lumberman Mutual",
  "Pennsylvania Manufacturers Ins",
  "Penske / Fast Track Claims",
  "Permanent General Assurance",
  "Pharmacists Mutual",
  "Philadelphia Insurance",
  "Pioneer Specialty Insurance",
  "Pioneer State Mutual",
  "Plymouth Rock",
  "PMA Group",
  "Porshe",
  "Praetorian Ins",
  "Preferred Auto Insurance (PAIC)",
  "Preferred Contractors Insurance Company",
  "Preferred Mutual",
  "Pride National Insurance",
  "Prime Property & Casualty Insurance",
  "Pro Sight Specialty Ins",
  "Progressive Insurance",
  "Protective Insurance",
  "Providence Mutual",
  "PURE",
  "QBE",
  "QBE First Insurance",
  "Qualitas Insurance",
  "Quantum Alliance",
  "Quincy Mutual",
  "RAWLINGS INS",
  "Redpoint Insurance",
  "Reliant General",
  "Rental Car Finance Corp",
  "Rental Claims Services / Rental Insurance Services",
  "RepWest/U-Haul",
  "Response Indemnity Co",
  "Responsive Auto Ins",
  "Rhode Island Insurance",
  "RLI Corp",
  "Rockford Mutual Insurance Co.",
  "Root Car Insurance",
  "Rural Mutual Ins",
  "Ryder Truck Rental / Fleet Management",
  "Safe Auto",
  "Safeco Insurance",
  "Safety Insurance",
  "Safeway Insurance",
  "Sagamore Insurance",
  "Samsung Fire & Marine Insurance",
  "Scottsdale Ins. aka National Casualty",
  "Sea Harbor Ins",
  "Seaview Insurance Co",
  "Secura Insurance",
  "Securian Casualty",
  "Security First",
  "Security National / Amtrust North America",
  "Sedgwick",
  "Selective Insurance Company of America",
  "Sentinel Ins",
  "SENTRY Insurance",
  "Shelter Insurance",
  "Sixt Rental Company",
  "Skyward Insurance",
  "SNAP Insurance",
  "Society Insurance",
  "Sompo International",
  "Sompo Japan & NipponKoa",
  "Southern County Mutual",
  "Southern Mutual Ins",
  "Southern Pioneer",
  "Southern Trust",
  "Sparta American Insurance Company",
  "Spinnaker Insurance Company",
  "Spirit Commercial Auto",
  "Sprinters Insurance",
  "St. Johns Insurance Company",
  "Standard Mutual Insurance",
  "Star Casualty Insurance",
  "State Auto",
  "State Farm Mutual Insurance",
  "Statewide Insurance",
  "Stillwater Property & Casualty Insurance",
  "Stonegate Insurance",
  "Stonewood Insurance",
  "Sun Coast General Ins",
  "Sutter Insurance Company",
  "Sutton National Insurance Company",
  "Swift Transit/Transportation",
  "Tennessee Farmers Mutual",
  "Tesla Insurance",
  "Texas Farm Bureau Insurance",
  "The General",
  "The Hartford",
  "The IMT Group",
  "Thrifty Rental Car/Rental Car Finance Corp",
  "Titan Insurance",
  "Toggle",
  "Tokio Marine America",
  "Topa Insurance Company",
  "Toyota Auto Insurance",
  "Traders Insurance",
  "Transguard Insurance",
  "Transit General Insurance",
  "Travelers Insurance (Standard Fire Ins.)",
  "Trexis",
  "Trumbull Insurance Company",
  "TURO",
  "Uber",
  "U-Haul",
  "Unigard Insurance Company",
  "Union Insurance Group",
  "Union Mutual Insurance Company",
  "Union Standard Insurance Co",
  "Unique Insurance/Producers National",
  "United Auto Ins (UAIG)",
  "United Equitable Insurance",
  "United Financial",
  "United Fire Group",
  "United Heritage",
  "United Home Insurance Company (LIQUIDATION)",
  "United Insurance Group",
  "United National Group",
  "United Specialty",
  "Unitrin",
  "Unitrin - WA Area",
  "Universal Property & Casualty",
  "UniVista Insurance",
  "UPS",
  "USA Insurance",
  "USAA",
  "Utica First Insurance",
  "Utica National Insurance Group",
  "Vanliner",
  "Vermont Mutual",
  "Verve Insurance",
  "Victoria Insurance - Part Of Nationwide",
  "Viking Insurance",
  "Viva Seguros",
  "Washington International Insurance Company",
  "Wawanesa Insurance",
  "Wayne Mutual Ins",
  "Wells Fargo Insurance Agency",
  "Wesco / Amtrust North America",
  "West American Ins",
  "West Bend Mutual",
  "Western General Insurance",
  "Western Heritage",
  "Western National Ins",
  "Western Reserve Group",
  "Western United Insurance",
  "Western World Insurance",
  "Westfield Insurance",
  "Williamsburg National",
  "Wilson Mutual Ins",
  "Windhaven Insurance (LIQUIDATION)",
  "Windhaven National Insurance (LIQUIDATION)",
  "Wisconsin Mutual",
  "Wolverine Mutual Insurance",
  "Woodlands",
  "Workmen's Auto",
  "XL Insurance",
  "Zipcar",
  "Zurich Insurance"
];
