
(function(){
  let supaClient = null;
  let broadcastChannel = null;
  let pushDebounceTimer = null;
  let suppressRemote = false;
  const SUPABASE_URL = "https://owjccmlgfhbusncvmbac.supabase.co";
  const SUPABASE_KEY = "sb_publishable_m5WPUe6APhOqHUQZOpj0-g_XZxzTVB5";
  window._SUPABASE_URL = SUPABASE_URL;
  window._SUPABASE_KEY = SUPABASE_KEY;

  function setSyncStatus(s){
    const el = document.getElementById("sync-status");
    if(!el) return;
    const map = {
      connected: ["☁️ Live",             "#2D5A1B"],
      synced:    ["✅ Gesynchroniseerd",  "#2D5A1B"],
      offline:   ["📴 Offline",           "#aaa"],
      error:     ["⚠️ Sync fout",         "#C1440E"],
      saving:    ["💾 Opslaan…",          "#C9A84C"],
      receiving: ["🔄 Ontvangen…",        "#C9A84C"]
    };
    const [txt,col] = map[s]||["—","#aaa"];
    el.textContent = txt; el.style.color = col;
  }

  window.initSupabase = function initSupabase(url, key){
    try{
      supaClient = supabase.createClient(url || SUPABASE_URL, key || SUPABASE_KEY);
      window._supaClient = supaClient;
      startSync();
    } catch(e){
      console.warn("Supabase init failed:", e);
      setSyncStatus("offline");
    }
  };

  // ── Deep field-level merge (newest timestamp wins per row) ──
  function deepMerge(local, remote){
    // Field-level merge: newest timestamp per checkbox row wins.
    // Prevents race conditions when two users check the same item simultaneously.
    const merged = Object.assign({}, local);
    for(const key of Object.keys(remote)){
      if(key === "_lastUpdate" || key === "loggedIn") continue;

      if(key === "_overdrachten"){
        // Merge by id — last-edit-wins per entry using editedTs||ts
        const byId = {};
        [...(local[key]||[]), ...(remote[key]||[])].forEach(e => {
          if(!e?.id) return;
          const existing = byId[e.id];
          if(!existing || (e.editedTs||e.ts||0) > (existing.editedTs||existing.ts||0)){
            byId[e.id] = e;
          }
        });
        merged[key] = Object.values(byId).sort((a,b)=>a.ts-b.ts);
        continue;
      }

      if(key === "_courtResets"){
        const locCR = local[key] || {}, remCR = remote[key] || {};
        merged[key] = Object.assign({}, locCR);
        for(const k of Object.keys(remCR)){
          merged[key][k] = Math.max(locCR[k]||0, remCR[k]||0);
        }
        continue;
      }

      if(key === "_users"){
        // Winner = most recently edited list (via _usersTs), then union as fallback
        const locTs = local._usersTs || 0;
        const remTs = remote._usersTs || 0;
        const locUsers = local[key] || [];
        const remUsers = remote[key] || [];
        if(locTs > remTs){
          merged[key] = locUsers;
        } else if(remTs > locTs){
          merged[key] = remUsers;
        } else {
          // Same or unknown — take union so nobody loses names
          merged[key] = [...new Set([...locUsers, ...remUsers])].sort((a,b)=>a.localeCompare(b,'nl'));
        }
        continue;
      }

      const loc = local[key], rem = remote[key];
      if(rem === null || rem === undefined) continue;
      if(Array.isArray(rem)){ merged[key] = rem; continue; }
      if(typeof rem !== "object"){ merged[key] = rem; continue; }

      // Court/gallery level (e.g. pc, sl, gal_CCSR)
      merged[key] = Object.assign({}, loc||{});
      for(const camKey of Object.keys(rem)){
        const locCam = (loc||{})[camKey], remCam = rem[camKey];
        if(typeof remCam !== "object" || remCam === null){
          merged[key][camKey] = remCam; continue;
        }
        // Camera level (e.g. cam1, cam2)
        merged[key][camKey] = Object.assign({}, locCam||{});
        for(const rowKey of Object.keys(remCam)){
          const locRow = (locCam||{})[rowKey], remRow = remCam[rowKey];
          if(typeof remRow !== "object" || remRow === null){
            // Scalar (e.g. collapsed bool) — remote wins
            merged[key][camKey][rowKey] = remRow; continue;
          }
          // Checkbox row — newest timestamp wins
          const locTs = locRow?.ts || 0, remTs = remRow?.ts || 0;
          if(remTs > locTs){
            merged[key][camKey][rowKey] = remRow;
          } else if(locTs > remTs){
            merged[key][camKey][rowKey] = locRow;
          } else {
            // Same timestamp — merge fields individually, checked:true wins
            merged[key][camKey][rowKey] = Object.assign({}, locRow, remRow);
            if(locRow?.checked || remRow?.checked){
              merged[key][camKey][rowKey].checked = true;
            }
          }
        }
      }
    }
    return merged;
  }

  function applyRemote(remoteData){
    if(suppressRemote){ pendingRemote = remoteData; return; } // bewaar, gooi niet weg
    const local = window._localLoad ? window._localLoad() : {};
    const preSnap = flatCheckedSnap(local);
    // Als remote een nieuwere reset heeft, data volledig vervangen i.p.v. mergen
    let merged;
    if((remoteData._resetTs||0) > (local._resetTs||0)){
      merged = Object.assign({}, remoteData);
    } else {
      // Pas per-court resets toe vóór merge
      const remCR = remoteData._courtResets || {};
      const locCR = local._courtResets || {};
      const localCopy = Object.assign({}, local);
      for(const k of Object.keys(remCR)){
        if((remCR[k]||0) > (locCR[k]||0)) delete localCopy[k];
      }
      merged = deepMerge(localCopy, remoteData);
    }
    merged._lastUpdate = Math.max(local._lastUpdate||0, remoteData._lastUpdate||0);
    if(window._localSaveRaw) window._localSaveRaw(merged);
    // Diff: find items whose checked state changed
    const postSnap = flatCheckedSnap(merged);
    const flashSet = new Set();
    for(const k of new Set([...Object.keys(preSnap), ...Object.keys(postSnap)])){
      if((preSnap[k]||false) !== (postSnap[k]||false)) flashSet.add(k);
    }
    if(window.buildAllLists) window.buildAllLists();
    if(window.refreshAll) window.refreshAll();
    if(window.renderOdLog) window.renderOdLog();
    if(flashSet.size > 0) flashRemoteItems(flashSet, merged);
    setSyncStatus("synced");
  }

  // ── PUSH: broadcast instantly + debounced DB write ──────────
  let offlineQueue  = null; // last data to sync when back online
  let pendingRemote = null; // remote update received during suppress window

  window.pushToSupabase = function(data){
    if(!supaClient) return;

    // 1. Broadcast instantly via websocket
    if(broadcastChannel){
      broadcastChannel.send({
        type: "broadcast",
        event: "state_update",
        payload: { data }
      }).catch(()=>{});
    }

    // 2. Persist to DB with debounce
    offlineQueue = data; // always keep latest
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(async ()=>{
      if(!navigator.onLine){ setSyncStatus("offline"); localStorage.setItem('rg_pending_sync','1'); return; }
      suppressRemote = true;
      setSyncStatus("saving");
      try{
        const { error } = await supaClient.from("checklist_state")
          .upsert({ id:1, data: offlineQueue }, { onConflict:"id" });
        if(error) throw error;
        offlineQueue = null;
        pushFailCount = 0;
        localStorage.removeItem('rg_pending_sync');
        setSyncStatus("synced");
      } catch(e){
        console.warn("DB push failed:", e);
        localStorage.setItem('rg_pending_sync','1');
        setSyncStatus("error");
        pushFailCount++;
        if(pushFailCount === 1){
          showToast("Opslaan mislukt — wijzigingen worden lokaal bewaard.");
        } else if(pushFailCount >= 3){
          showToast("Verbinding verbroken. Controleer je internet.");
          pushFailCount = 0;
        }
      }
      setTimeout(()=>{
        suppressRemote = false;
        if(pendingRemote){ // verwerk gemiste remote update alsnog
          const queued = pendingRemote;
          pendingRemote = null;
          applyRemote(queued);
        }
      }, 300);
    }, 200);
  };

  // Flush queue when coming back online
  window.addEventListener("online", ()=>{
    setSyncStatus("connected");
    if(offlineQueue){
      window.pushToSupabase(offlineQueue);
    } else if(localStorage.getItem('rg_pending_sync')){
      // App was gesloten terwijl offline — push huidige lokale data
      const current = window._localLoad ? window._localLoad() : {};
      window.pushToSupabase(current);
    }
  });
  window.addEventListener("offline", ()=>{ setSyncStatus("offline"); });

  function startSync(){
    if(!supaClient) return;

    // ── Broadcast channel (instant peer-to-peer) ──────────────
    broadcastChannel = supaClient.channel("rg-live-updates");
    broadcastChannel
      .on("broadcast", { event: "state_update" }, ({ payload })=>{
        if(!payload?.data) return;
        setSyncStatus("receiving");
        applyRemote(payload.data);
      })
      .subscribe(status=>{
        if(status === "SUBSCRIBED") setSyncStatus("synced");
        if(status === "CLOSED" || status === "CHANNEL_ERROR") setSyncStatus("offline");
      });

    // ── DB channel (catch up on reconnect / missed messages) ──
    supaClient
      .channel("rg-db-sync")
      .on("postgres_changes",{ event:"UPDATE", schema:"public", table:"checklist_state" },
        payload=>{
          if(suppressRemote) return;
          const remoteData = payload.new?.data;
          if(!remoteData) return;
          applyRemote(remoteData);
        })
      .subscribe();

    // ── Pull latest state on first connect ────────────────────
    supaClient.from("checklist_state")
      .select("data").eq("id",1).single()
      .then(({data: row, error})=>{
        if(error){ setSyncStatus("error"); showToast("Kon data niet ophalen van server."); return; }
        if(row?.data) applyRemote(row.data);
        // Seed default users AFTER first remote sync so we don't get overwritten
        seedDefaultUsers();
        // Als er ongesyncte lokale wijzigingen zijn, push de gemerge data terug
        if(localStorage.getItem('rg_pending_sync')){
          const current = window._localLoad ? window._localLoad() : {};
          window.pushToSupabase(current);
          showToast("Offline wijzigingen gesynchroniseerd.");
        }
        setSyncStatus("synced");
      });
  }

  let pushFailCount = 0;

  function showToast(msg){
    let el = document.getElementById("sync-toast");
    if(!el){
      el = document.createElement("div");
      el.id = "sync-toast";
      el.style.cssText = "position:fixed;bottom:72px;left:50%;transform:translateX(-50%);background:#C1440E;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.3);transition:opacity .3s";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(()=>{ el.style.opacity = "0"; }, 4000);
  }

  function flatCheckedSnap(data){
    const snap = {};
    const camSections = new Set(['pc','sl','sm','c14']);
    for(const sk of Object.keys(data)){
      const section = data[sk];
      if(typeof section !== 'object' || section === null || Array.isArray(section)) continue;
      if(camSections.has(sk)){
        for(const camKey of Object.keys(section)){
          const cd = section[camKey];
          if(typeof cd !== 'object' || cd === null) continue;
          for(const row of Object.keys(cd)){
            const val = cd[row];
            if(typeof val === 'object' && val !== null && 'checked' in val)
              snap[`${sk}/${camKey}/${row}`] = val.checked || false;
          }
        }
      } else if(sk.startsWith('comm_')){
        for(const pos of Object.keys(section)){
          const pd = section[pos];
          if(typeof pd !== 'object' || pd === null) continue;
          for(const chk of Object.keys(pd)){
            if(typeof pd[chk] === 'boolean') snap[`${sk}/${pos}/${chk}`] = pd[chk];
          }
        }
      } else {
        for(const idx of Object.keys(section)){
          const entry = section[idx];
          if(typeof entry === 'object' && entry !== null && 'checked' in entry)
            snap[`${sk}/${idx}`] = entry.checked || false;
        }
      }
    }
    return snap;
  }

  function flashRemoteItems(flashSet, mergedData){
    if(!flashSet || flashSet.size === 0) return;
    const camSections = new Set(['pc','sl','sm','c14']);
    // Collect changed-by users for toast
    const users = new Set();
    for(const path of flashSet){
      const parts = path.split('/');
      const sk = parts[0];
      const section = (mergedData||{})[sk];
      if(!section) continue;
      if(camSections.has(sk)){
        const cd = section[parts[1]];
        if(cd){ const rd = cd[parts[2]]; if(rd?.user) users.add(rd.user); }
      } else if(!sk.startsWith('comm_')){
        const entry = section[parts[1]];
        if(entry?.user) users.add(entry.user);
      }
    }
    const myUser = window.getCurrentUser ? window.getCurrentUser() : null;
    users.delete(myUser);
    const whoStr = users.size > 0 ? ' door ' + [...users].join(', ') : '';
    showToast(`${flashSet.size} item${flashSet.size>1?'s':''} gewijzigd${whoStr}`);
    // Flash matching DOM rows
    for(const path of flashSet){
      const parts = path.split('/');
      const sk = parts[0];
      const containerId = 'list-' + sk.replace(/_/g,'-');
      let el = null;
      if(camSections.has(sk)){
        const camNum = parseInt(parts[1].replace('cam',''));
        const row = parts[2];
        const rows = typeof getRows === 'function' ? getRows(sk, camNum) : [];
        const j = rows.indexOf(row);
        if(j >= 0) el = document.getElementById(`${containerId}-row-${camNum}-${j}`);
      } else if(sk.startsWith('comm_')){
        const pos = parts[1], chk = parts[2];
        const j = typeof POS_CHECKS !== 'undefined' ? POS_CHECKS.indexOf(chk) : -1;
        if(j >= 0) el = document.getElementById(`${containerId}-posrow-${pos}-${j}`);
      } else {
        el = document.getElementById(`${containerId}-srow-${parts[1]}`);
      }
      if(el) el.classList.add('remote-flash');
    }
    setTimeout(()=>{
      document.querySelectorAll('.remote-flash').forEach(e => e.classList.remove('remote-flash'));
    }, 3000);
    playSyncChime();
  }

  function playCheckTick(){
    try{
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.07, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1100, ctx.currentTime);
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
      osc.onended = () => ctx.close();
    } catch(e){}
  }
  window.playCheckTick = playCheckTick;

  function playSyncChime(){
    try{
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.9);
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.9);
      osc.onended = () => ctx.close();
    } catch(e){}
  }

  document.addEventListener("DOMContentLoaded", ()=>{
    setTimeout(()=>window.initSupabase(), 300);
  });

})();



// ── AUDIO STAGEBOX DATA ──────────────────────────────────────────
const PC_SB_ITEMS  = ['A-STAGE64 NORTH PIT','A-STAGE64 SOUTH TRIBUNE','A-MIC8 WEST TRIBUNE','A-MIC8 EAST TRIBUNE'];
const SL_SB_ITEMS  = ['A-STAGE64 SOUTH PIT','A-MIC8 SOUTH EAST TOWER','A-MIC8 SOUTH WEST TOWER'];
const SM_SB_ITEMS  = ['A-STAGE64 SOUTH PIT','S-STAGE64 TECH CABIN'];
const C14_SB_ITEMS = ['A-STAGE64 WEST TRIBUNE','A-MIC8 TECH ROOM'];

// ── AUDIO MIC DATA ───────────────────────────────────────────────
const PC_MIC_ITEMS  = ["Mic01 · MKH 416 · FFT Bracket · Server Near L","Mic02 · MKH 416 · FFT Bracket · Server Near R","Mic03 · MKH 816 · Camera Support · Cam 3 FX","Mic04 · MKH 816 · Camera Support · Cam 4 FX","Mic05 · MKH 416 · FFT Bracket · Server Far L","Mic06 · MKH 416 · FFT Bracket · Server Far R","Mic07 · AT4029 Stereo · On cam · Handheld Cam","Mic08 · MKH 416 · Table clamp · Sit Near Mic","Mic09 · MKH 8060 · Vis K&M · Argue Mic Near","Mic10 · MKH 8060 · Vis K&M · Argue Mic Far","Mic11 · MKH 416 · Table clamp · Sit Far Mic","Mic12 · MKH 416 · Spidercam Support · Spidercam","Mic13 · MKH 416 · Magic Arm · Baseline Near","Mic14 · MKH 416 · Magic Arm · Baseline Far","Mic15 · RF mic (FFT provided) · Umpire","Mic16 · MKE2 xlr · Playerbox L","Mic17 · MKE2 xlr · Playerbox R","Mic18 · MKH 8070 · Magic Arm · Middle Sit","Mic19 · AT4029 · Camera Support · RF Cam 20 FX","Mic20 · AT4029 · Camera Support · RF Cam 21 FX","Mic21 · AT4029 · Magic Arm · Upstairs Hall","Mic22 · AT4029 · Magic Arm · Locker Room","Mic23 · MD46 · Handheld · Cam 23 Interview","Mic24 · MD46 · Handheld · Cam 23 Intv BU","Mic25 · AT4029 · Magic Arm · Cam 1 UPS cam","Mic26 · DPA5100 Surround · West · Surround Amb","Mic27 · DPA5100 Surround · East · Surround Amb","Mic28 · MSTC 64U Stereo · Center · Stereo Amb"];
const SL_MIC_ITEMS  = ["Mic01 · MKH 416 · FFT Bracket · Server Near L","Mic02 · MKH 416 · FFT Bracket · Server Near R","Mic03 · MKH 816 · Camera Support · Cam 3 FX","Mic04 · MKH 816 · Camera Support · Cam 4 FX","Mic05 · MKH 416 · FFT Bracket · Server Far L","Mic06 · MKH 416 · FFT Bracket · Server Far R","Mic07 · AT4029 Stereo · On cam · Handheld Cam","Mic08 · MKH 416 · Table clamp · Sit Near Mic","Mic09 · MKH 8060 · Vis K&M · Argue Mic Near","Mic10 · MKH 8060 · Vis K&M · Argue Mic Far","Mic11 · MKH 416 · Table clamp · Sit Far Mic","Mic12 · MKH 416 · Spidercam Support · Spidercam","Mic13 · MKH 416 · Magic Arm · Baseline Near","Mic14 · MKH 416 · Magic Arm · Baseline Far","Mic15 · RF mic (FFT provided) · Umpire","Mic16 · MKE2 xlr · Playerbox L","Mic17 · MKE2 xlr · Playerbox R","Mic18 · MKH 8070 · Magic Arm · Middle Sit","Mic19 · AT4029 · Magic Arm · Hall","Mic20 · AT4029 · Magic Arm · Remote Camera 10","Mic21 · CMC6+MK4 · Suspended · West ORTF Near","Mic22 · CMC6+MK4 · Suspended · West ORTF Far","Mic23 · CMC6+MK4 · Suspended · East ORTF Near","Mic24 · CMC6+MK4 · Suspended · East ORTF Far","Mic25 · DPA5100 · Surround Center · Surround Amb","Mic26 · MD46 · Handheld · Cam 18 Interview","Mic27 · MD46 · Handheld · Cam 23 Intv BU","Mic28 · AT4029 · Magic Arm · Cam 1 UPS cam"];
const SM_MIC_ITEMS  = ["Mic01 · MKH 416 · FFT Bracket · Server Near L","Mic02 · MKH 416 · FFT Bracket · Server Near R","Mic03 · MKH 816 · Camera Support · Cam 3 FX","Mic04 · MKH 816 · Camera Support · Cam 4 FX","Mic05 · MKH 416 · FFT Bracket · Server Far L","Mic06 · MKH 416 · FFT Bracket · Server Far R","Mic07 · AT4029 Stereo · On cam · Handheld Cam","Mic08 · MKH 416 · Table clamp · Sit Near Mic","Mic09 · MKH 8060 · Vis K&M · Argue Mic Near","Mic10 · MKH 8060 · Vis K&M · Argue Mic Far","Mic11 · MKH 416 · Table clamp · Sit Far Mic","Mic12 · RF mic (FFT provided) · Umpire","Mic13 · MKH 416 · Magic Arm · Baseline Near","Mic14 · MKH 416 · Magic Arm · Baseline Far","Mic15 · MKH 8070 · Magic Arm · Middle Sit","Mic16 · MD46 · Handheld · Cam 12 Interview","Mic17 · MD46 · Handheld · Cam 12 Intv BU","Mic18 · MSTC 64U · Center · Center ORTF","Mic19 · AT4029 · Magic Arm · Cam 2 UPS cam"];
const C14_MIC_ITEMS = ["Mic01 · MKH 416 · FFT Bracket · Server Near L","Mic02 · MKH 416 · FFT Bracket · Server Near R","Mic03 · MKH 416 · Camera Support · Cam 3 FX","Mic04 · MKH 416 · Camera Support · Cam 4 FX","Mic05 · MKH 416 · FFT Bracket · Server Far L","Mic06 · MKH 416 · Camera Support C6 · Server Far R","Mic07 · AT4029 Stereo · On cam · Handheld Cam","Mic08 · MKH 416 · Table clamp · Sit Near Mic","Mic09 · MKH 8060 · Vis K&M · Argue Mic Near","Mic10 · MKH 8060 · Vis K&M · Argue Mic Far","Mic11 · MKH 416 · Table clamp · Sit Far Mic","Mic12 · RF mic (FFT provided) · Umpire","Mic13 · MKH 8070 · Magic Arm · Middle Sit","Mic14 · MD46 · Handheld · Cam 7 Interview","Mic15 · AT4029 · Magic Arm C1 pole · Cam 2 UPS cam","Mic16 · MKH 416 · Camera Support · RF cam 4 or 5"];


const GALLERY_ITEMS = [
  ["CCSR",           "Camera Control Shading Room"],
  ["CIR",            ""],
  ["MCR",            "Master Control Room"],
  ["INTERCOM",       "Comms"],
  ["FFT",            "Fédération Française de Tennis"],
  ["RF CAMS",        "RF"],
  ["NOVA 105",       "EMG NOVA 105"],
  ["SL PRODUCTION",  "Suzanne Lenglen Production"],
  ["SL AUDIO",       "Suzanne Lenglen Audio"],
  ["SM PRODUCTION",  "Simonne Mathieu Production"],
  ["SM AUDIO",       "Simonne Mathieu Audio"],
  ["EIC/AIC GALLERY'S","Engineer In Charge / Audio In Charge"],
  ["EMG OFFICE",     "Kantoor"],
  ["EVS SL",         "Slomo's Suzanne Lenglen"],
  ["EVS PC",         "Slomo's Philippe Chatrier"],
  ["QC AUDIO",       "Quality Control Audio"],
  ["QC PRODUCTION",  "Quality Control Production"],
  ["VENUE SCREEN",   "Venue Screen Feed"],
  ["GFX",            "Graphics"],
];

const C14_CAMS = [
  {num:1, type:"Remote · x4.3",        pos:"South Stand – Main High Centred"},
  {num:2, type:"Tripod · x86",          pos:"South Stand – Mid Centred"},
  {num:3, type:"Tripod · x22",          pos:"East Side – Court level Left of Net"},
  {num:4, type:"Tripod · x22",          pos:"East Side – Court level Right of Net"},
  {num:5, type:"Sheffield Plate · x86", pos:"South Stand – In South Stand"},
  {num:6, type:"Sheffield Plate · X86", pos:"North Stand – SuperSlo"},
  {num:7, type:"Handheld · x4.7",       pos:"West Side – RF Handheld Umpire & Flash interviews"},
  {num:8, type:"Fixed · xWA",           pos:"North Stand – Beauty camera top of building"},
];
const CAM_ROWS = ["FIBERS","SMPTE","SHED/CCU","CAMERA"];

const CCSR_ITEMS = [
  "EIC","DIPLOY 1","DIPLOY 2","TECH MANAGER",
  "HDR SUP 1","HDR SUP 2","NETCAM/ACS",
  "SL 1/2","SL 3/4","SM 1/2","SM 3","RF/PRESS"
];
const CIR_ITEMS = ["TOC MANAGER"];
const MCR_ITEMS = ["MCR OPERATOR 1", "MCR OPERATOR 2", "MCR MANAGER", "AIC MCR", "EIC MCR", "IP-DIRECTOR/HOTSEAT", "TELSTRA"];
const INTERCOM_ITEMS = ["COMMS ENGINEER", "RF COMMS"];
const FFT_ITEMS = ["FFT"];
const RF_CAMS_ITEMS = ["RF OP 1"];
const NOVA_105_ITEMS = ["PC DIRECTOR", "PC VISION MIXER", "PC GFX", "PC REMOTE OP 1", "PC REMOTE OP 2", "PC AUDIO", "PC VISION 1", "PC VISION 2", "PC VISION 3", "PC VISION 4", "PC VISION 5", "C14 DIRECTOR", "C14 GFX", "C14 REMOTE OP 6", "C14 EVS OP 1", "C14 EVS OP 2", "C14 AUDIO"];
const SL_PRODUCTION_ITEMS = ["SL DIRECTOR", "SL VISION MIXER", "SL GFX", "SL REMOTE OP3", "SL REMOTE OP 4"];
const SL_AUDIO_ITEMS = ["SL AUDIO"];
const SM_PRODUCTION_ITEMS = ["SM DIRECTOR", "SM GFX", "SM REMOTE OP 5", "SM EVS OP 1", "SM EVS OP 2", "SM EVS OP 3"];
const SM_AUDIO_ITEMS = ["SM AUDIO"];
const EIC_AIC_ITEMS = ["EIC GALLERY'S", "AIC GALLERY'S"];
const EMG_OFFICE_ITEMS = ["REMCO", "PETER"];
const EVS_SL_ITEMS = ["SL EVS CO-ORD", "SL EVS OP 1", "SL EVS OP 2", "SL EVS OP 3", "SL EVS OP 4", "SL EVS OP 5"];
const EVS_PC_ITEMS = ["PC EVS CO-ORD", "PC EVS OP 1", "PC EVS OP 2", "PC EVS OP 3", "PC EVS OP 4", "PC EVS OP 5"];
const QC_AUDIO_ITEMS = ["QC AUDIO"];
const QC_PRODUCTION_ITEMS = ["VIDEO QC 1", "VIDEO QC 2"];
const VENUE_SCREEN_ITEMS = [];
const GFX_ITEMS = ["GFX 1", "GFX 2"];

const BLANK_CAMS = [
  {num:1,type:"",pos:""},{num:2,type:"",pos:""},{num:3,type:"",pos:""},
  {num:4,type:"",pos:""},{num:5,type:"",pos:""},{num:6,type:"",pos:""},
  {num:7,type:"",pos:""},{num:8,type:"",pos:""},
];

const PC_CAMS = [
  {num:1,type:"Tripod · x22",pos:"Main - High centred"},
  {num:2,type:"Tripod · x86",pos:"Mid centred"},
  {num:3,type:"Tripod · x86",pos:"Court level - Left of Net"},
  {num:4,type:"Tripod · x86",pos:"Court level - Right of Net"},
  {num:5,type:"Tripod · x86",pos:"SuperSlo - SE Corner"},
  {num:6,type:"Tripod · x86",pos:"SuperSlo in Brugnon stand"},
  {num:7,type:"Handheld · x4.7",pos:"RF Handheld by Umpire"},
  {num:8,type:"Tripod · x100",pos:"UltraMo Behind cameras 3 & 4"},
  {num:9,type:"Tripod · x86",pos:"Box Lens in Lacoste stand pit"},
  {num:10,type:"Remote · x22",pos:"Remote - NW corner of court"},
  {num:11,type:"Aerial · xWA",pos:"4-point Aerial Camera System"},
  {num:12,type:"PTZ · x22",pos:"Baseline Cam - Near"},
  {num:13,type:"PTZ · x22",pos:"Baseline Cam - Far"},
  {num:14,type:"Remote · xWA",pos:"Remote - Player Box 1"},
  {num:15,type:"Remote · xWA",pos:"Remote - Player Box 2"},
  {num:16,type:"Fixed · xWA",pos:"Netcam - Near"},
  {num:17,type:"Fixed · xWA",pos:"Netcam - Far"},
  {num:18,type:"PTZ · xWA",pos:"On LEDS to the left"},
  {num:19,type:"Tripod · x86",pos:"Corner on concrete wall"},
  {num:20,type:"RF Handheld · xWA",pos:"RF - Gimbal"},
  {num:21,type:"PTZ · xWA",pos:"Interior - Upstairs Hall"},
  {num:22,type:"PTZ · xWA",pos:"Interior - Downstairs Hall"},
  {num:23,type:"Handheld · xWA",pos:"Unmanned post-match IV's"},
  {num:24,type:"Fixed · xWA",pos:"Beauty shot of court"},
];
const SL_CAMS = [
  {num:1,type:"Tripod · x22",pos:"Main - High centred"},
  {num:2,type:"Tripod · x86",pos:"Mid centred"},
  {num:3,type:"Tripod · x86",pos:"Court level - Left of Net"},
  {num:4,type:"Tripod · x86",pos:"Court level - Right of Net"},
  {num:5,type:"Tripod · x86",pos:"SuperSlo in South pit"},
  {num:6,type:"Special Mount · x86",pos:"SuperSlo in NE stand"},
  {num:7,type:"Handheld · x4.7",pos:"RF Handheld by Umpire"},
  {num:8,type:"Tripod · x100",pos:"UltraMo between cams 3 & 4"},
  {num:9,type:"Tripod · x86",pos:"Box Lens in South Pit"},
  {num:10,type:"Remote · x22",pos:"Corner in NW corner"},
  {num:11,type:"Aerial · xWA",pos:"3rd Party Providing"},
  {num:12,type:"PTZ · x22",pos:"Baseline - Near"},
  {num:13,type:"PTZ · x22",pos:"Baseline - Far"},
  {num:14,type:"Remote · xWA",pos:"Remote - Player Box 1"},
  {num:15,type:"Remote · xWA",pos:"Remote - Player Box 2"},
  {num:16,type:"Fixed · xWA",pos:"Netcam - Near"},
  {num:17,type:"Fixed · xWA",pos:"Netcam - Far"},
  {num:18,type:"PTZ · xWA",pos:"In corner by LEDS to the left"},
  {num:19,type:"Handheld · x4.7",pos:"Unmanned Handheld for IV's"},
  {num:20,type:"Fixed · xWA",pos:"Beauty Shot of Court"},
];
const SM_CAMS = [
  {num:1,type:"Remote · x22",pos:"Main - High centred"},
  {num:2,type:"Tripod · x86",pos:"Mid centred"},
  {num:3,type:"Tripod · x86",pos:"Court level - Left of Net"},
  {num:4,type:"Tripod · x86",pos:"Court level - Right of Net"},
  {num:5,type:"Tripod · x86",pos:"SuperSlo SW pit level"},
  {num:6,type:"Tripod · x100",pos:"UltraMo North stand"},
  {num:7,type:"Handheld · x4.7",pos:"RF Handheld by Umpire"},
  {num:8,type:"PTZ · xWA",pos:"Remote - Baseline Near"},
  {num:9,type:"PTZ · xWA",pos:"Remote - Baseline Far"},
  {num:10,type:"Netcam · xWA",pos:"Netcam facing near"},
  {num:11,type:"Netcam · xWA",pos:"Netcam facing far"},
  {num:12,type:"Handheld · xWA",pos:"Unmanned Handheld for IV's"},
  {num:13,type:"Fixed · xWA",pos:"Beauty shot of court"},
];

const SK = "rg2025_v1";
function load(){ try{ return JSON.parse(localStorage.getItem(SK))||{}; }catch{ return {}; } }
function _localSaveRaw(d){ try{ localStorage.setItem(SK,JSON.stringify(d)); }catch{} }
window._localLoad = load;
window._localSaveRaw = _localSaveRaw;

function save(d){
  d._lastUpdate = Date.now();
  _localSaveRaw(d);
  updateLastUpdateLabel();
  if(window.pushToSupabase) window.pushToSupabase(d);
}
function saveFast(d){
  d._lastUpdate = Date.now();
  _localSaveRaw(d);
  updateLastUpdateLabel();
  if(window.pushToSupabase) window.pushToSupabase(d);
  refreshCounters(); refreshAudioCounters();
}
function getCurrentUser(){ return localStorage.getItem("rg_user")||""; }
function setCurrentUser(n){ localStorage.setItem("rg_user",n); }
function fmtTime(ts){
  if(!ts) return "—";
  const d=new Date(ts);
  return d.toLocaleDateString("nl-NL",{day:"2-digit",month:"2-digit"})+" "+
         d.toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"});
}
function updateLastUpdateLabel(){
  const d=load();
  const el=document.getElementById("last-update-label");
  if(el) el.textContent=d._lastUpdate?"Laatste update: "+fmtTime(d._lastUpdate):"Geen wijzigingen";
}

let _handlingPop = false;
function goTo(id){
  const d = load();
  if(id !== 'page-login' && !d.loggedIn){
    id = 'page-login';
  }
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  const el = document.getElementById(id);
  if(el) el.classList.add("active");
  window.scrollTo(0,0);
  if(!_handlingPop){
    history.pushState({ page: id }, '', location.pathname + location.search);
  }
  refreshAll();
  // Auto-init pages that need it
  if(id === 'page-overdracht'){ buildOverdracht(); setOdLastRead(); }
  if(['page-audio-pc','page-audio-sl','page-audio-sm','page-audio-c14'].includes(id)) buildAudioLists();
  if(id === 'page-users') buildUsers();
  if(id === 'page-problems') buildProblems();
  if(id === 'page-persons') buildPersons();
  // Resize textareas met bestaande inhoud na pagina-wissel
  requestAnimationFrame(()=>{ document.querySelectorAll('textarea').forEach(resizeTextarea); });
}

// Emails zijn alleen identifiers voor Supabase Auth — geen echte mailbox nodig.
// Maak deze gebruikers aan in Supabase Dashboard → Authentication → Users.
const TEAM_AUTH_EMAIL  = "team@rg2026.app";
const ADMIN_AUTH_EMAIL = "admin@rg2026.app";

async function doLogin(){
  const name = document.getElementById('login-name').value.trim();
  const pw   = document.getElementById('login-pw').value;
  const inp  = document.getElementById('login-pw');

  if(!name){
    const sel = document.getElementById('login-name');
    sel.style.borderColor = "#C1440E";
    setTimeout(()=>{ sel.style.borderColor=""; }, 2000);
    return;
  }

  const client = window._supaClient;
  if(!client){
    inp.style.borderColor = "#C1440E";
    inp.placeholder = "Geen verbinding — probeer opnieuw…";
    setTimeout(()=>{ inp.style.borderColor=""; inp.placeholder="Wachtwoord"; }, 2000);
    return;
  }

  let authError = null;
  try {
    const result = await client.auth.signInWithPassword({
      email: TEAM_AUTH_EMAIL,
      password: pw
    });
    authError = result.error;
  } catch(e) {
    authError = e;
    console.error("Login fout:", e);
  }

  if(!authError){
    if(name) setCurrentUser(name);
    const d = load(); d.loggedIn = true; d.loginTs = Date.now(); save(d);
    if(navigator.vibrate) navigator.vibrate([30, 50, 30]);
    goTo('page-home');
    setTimeout(initPresence, 800);
  } else {
    inp.style.borderColor = "#C1440E";
    inp.value = "";
    inp.placeholder = "Fout: " + (authError.message || "Onjuist wachtwoord");
    console.error("Auth fout:", authError);
    setTimeout(()=>{ inp.style.borderColor=""; inp.placeholder="Wachtwoord"; }, 3000);
  }
}

function logout(){
  try {
    const d = load();
    delete d.loggedIn;
    localStorage.setItem(SK, JSON.stringify(d));
  } catch(e){}
  if(navigator.vibrate) navigator.vibrate(20);
  // Navigate first, always
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const loginPage = document.getElementById('page-login');
  if(loginPage) loginPage.classList.add('active');
  window.scrollTo(0,0);
}

window.buildAllLists = function buildAllLists(){
  buildGallery();
  buildSimpleList("list-gal-CCSR","gal_CCSR",CCSR_ITEMS);
  buildSimpleList("list-gal-CIR","gal_CIR",CIR_ITEMS);
  buildSimpleList("list-gal-MCR","gal_MCR",MCR_ITEMS);
  buildSimpleList("list-gal-INTERCOM","gal_INTERCOM",INTERCOM_ITEMS);
  buildSimpleList("list-gal-FFT","gal_FFT",FFT_ITEMS);
  buildSimpleList("list-gal-RF-CAMS","gal_RF_CAMS",RF_CAMS_ITEMS);
  buildSimpleList("list-gal-NOVA-105","gal_NOVA_105",NOVA_105_ITEMS);
  buildSimpleList("list-gal-SL-PRODUCTION","gal_SL_PRODUCTION",SL_PRODUCTION_ITEMS);
  buildSimpleList("list-gal-SL-AUDIO","gal_SL_AUDIO",SL_AUDIO_ITEMS);
  buildSimpleList("list-gal-SM-PRODUCTION","gal_SM_PRODUCTION",SM_PRODUCTION_ITEMS);
  buildSimpleList("list-gal-SM-AUDIO","gal_SM_AUDIO",SM_AUDIO_ITEMS);
  buildSimpleList("list-gal-EIC-AIC","gal_EIC_AIC",EIC_AIC_ITEMS);
  buildSimpleList("list-gal-EMG-OFFICE","gal_EMG_OFFICE",EMG_OFFICE_ITEMS);
  buildSimpleList("list-gal-EVS-SL","gal_EVS_SL",EVS_SL_ITEMS);
  buildSimpleList("list-gal-EVS-PC","gal_EVS_PC",EVS_PC_ITEMS);
  buildSimpleList("list-gal-QC-AUDIO","gal_QC_AUDIO",QC_AUDIO_ITEMS);
  buildSimpleList("list-gal-QC-PRODUCTION","gal_QC_PRODUCTION",QC_PRODUCTION_ITEMS);
  buildSimpleList("list-gal-VENUE-SCREEN","gal_VENUE_SCREEN",VENUE_SCREEN_ITEMS);
  buildSimpleList("list-gal-GFX","gal_GFX",GFX_ITEMS);
  buildCamPage("list-c14","c14",C14_CAMS);
  buildCamPage("list-pc","pc",PC_CAMS);
  buildCamPage("list-sl","sl",SL_CAMS);
  buildCamPage("list-sm","sm",SM_CAMS);
  buildAudioLists();
  buildPosList("list-comm-pc4th","comm_pc4th",PC4TH_POSITIONS);
  buildPosList("list-comm-pc5th","comm_pc5th",PC5TH_POSITIONS);
  buildPosList("list-comm-sl","comm_sl",COMMSL_POSITIONS);
  buildPosList("list-comm-sm","comm_sm",COMMSM_POSITIONS);
  rebuildNameDropdown();
  const remembered = getCurrentUser();
  if(remembered){
    const sel = document.getElementById("login-name");
    if(sel) Array.from(sel.options).forEach(o=>{ if(o.value===remembered) o.selected=true; });
  }
}

function initApp(){
  // Apply saved theme immediately before anything renders
  const savedTheme = localStorage.getItem('rg_theme');
  if(savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  const darkBtn = document.querySelector('.dark-toggle');
  if(darkBtn) darkBtn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';

  buildAllLists();
  var d = load();
  const SESSION_HOURS = 12;
  const lastActivity = parseInt(localStorage.getItem('rg_last_activity') || '0') || (d.loginTs || 0);
  const sessionExpired = lastActivity && (Date.now() - lastActivity) > SESSION_HOURS * 60 * 60 * 1000;
  if(d.loggedIn && !sessionExpired){
    goTo('page-home');
    setTimeout(initPresence, 1000);
  } else {
    if(sessionExpired) logout();
    goTo('page-login');
  }
}

document.addEventListener('DOMContentLoaded', initApp);

// Houd laatste activiteit bij
function touchActivity(){ localStorage.setItem('rg_last_activity', Date.now()); }
document.addEventListener('click',      touchActivity, { passive: true });
document.addEventListener('touchstart', touchActivity, { passive: true });

// Controleer sessie elk uur — alleen uitloggen bij inactiviteit
setInterval(()=>{
  const d = load();
  if(!d.loggedIn) return;
  const lastActivity = parseInt(localStorage.getItem('rg_last_activity') || '0') || (d.loginTs || 0);
  if(Date.now() - lastActivity > 12 * 60 * 60 * 1000){
    logout();
    goTo('page-login');
  }
}, 60 * 60 * 1000);

function toggle(el, section){
  el.classList.toggle("done");
  const d = load();
  if(!d.checks) d.checks={};
  const items = document.querySelectorAll(`#list-${section} .check-item`);
  items.forEach((item,i)=>{ d.checks[`${section}_${i}`] = item.classList.contains("done"); });
  save(d); refreshAll();
}

function restoreChecks(section){
  const d = load();
  if(!d.checks) return;
  const items = document.querySelectorAll(`#list-${section} .check-item`);
  items.forEach((item,i)=>{ if(d.checks[`${section}_${i}`]) item.classList.add("done"); });
}

function buildGallery(){
  const d = load();
  if(!d.gal) d.gal = {};
  const wrap = document.getElementById("gal-nav-list");
  if(!wrap) return;
  wrap.innerHTML = "";
  const keys = ['CCSR', 'CIR', 'MCR', 'INTERCOM', 'FFT', 'RF-CAMS', 'NOVA-105', 'SL-PRODUCTION', 'SL-AUDIO', 'SM-PRODUCTION', 'SM-AUDIO', 'EIC-AIC', 'EMG-OFFICE', 'EVS-SL', 'EVS-PC', 'QC-AUDIO', 'QC-PRODUCTION', 'VENUE-SCREEN', 'GFX'];
  const labels = ['CCSR', 'CIR', 'MCR', 'INTERCOM', 'FFT', 'RF CAMS', 'NOVA 105', 'SL PRODUCTION', 'SL AUDIO', 'SM PRODUCTION', 'SM AUDIO', "EIC/AIC GALLERY'S", 'EMG OFFICE', 'EVS SL', 'EVS PC', 'QC AUDIO', 'QC PRODUCTION', 'VENUE SCREEN', 'GFX'];
  const notes = ['Camera Control Shading Room', '', 'Master Control Room', 'Comms', 'Fédération Française de Tennis', 'RF', 'EMG NOVA 105', 'Suzanne Lenglen Production', 'Suzanne Lenglen Audio', 'Simonne Mathieu Production', 'Simonne Mathieu Audio', 'Engineer In Charge / Audio In Charge', 'Kantoor', "Slomo's Suzanne Lenglen", "Slomo's Philippe Chatrier", 'Quality Control Audio', 'Quality Control Production', 'Venue Screen Feed', 'Graphics'];
  keys.forEach((key, i) => {
    const done = galItemDone(key);
    const total = galItemTotal(key);
    const div = document.createElement("div");
    div.className = "nav-item";
    div.onclick = () => goTo("page-gal-" + key);
    div.innerHTML = `
      <div class="nav-item-text">
        <div class="item-label">${labels[i]}</div>
        ${notes[i] ? `<div class="item-note">${notes[i]}</div>` : ""}
        <div class="item-note" id="gal-note-${key}">${done} van ${total} voltooid</div>
      </div>
      <div class="nav-item-right">
        <span class="nav-pct" id="gal-pct-${key}">${done}/${total}</span>
        <span class="nav-arrow">→</span>
      </div>`;
    wrap.appendChild(div);
  });
}

const GAL_TOTALS = {
  "CCSR":CCSR_ITEMS.length,"CIR":CIR_ITEMS.length,"MCR":MCR_ITEMS.length,
  "INTERCOM":INTERCOM_ITEMS.length,"FFT":FFT_ITEMS.length,"RF-CAMS":RF_CAMS_ITEMS.length,
  "NOVA-105":NOVA_105_ITEMS.length,"SL-PRODUCTION":SL_PRODUCTION_ITEMS.length,
  "SL-AUDIO":SL_AUDIO_ITEMS.length,"SM-PRODUCTION":SM_PRODUCTION_ITEMS.length,
  "SM-AUDIO":SM_AUDIO_ITEMS.length,"EIC-AIC":EIC_AIC_ITEMS.length,
  "EMG-OFFICE":EMG_OFFICE_ITEMS.length,"EVS-SL":EVS_SL_ITEMS.length,
  "EVS-PC":EVS_PC_ITEMS.length,"QC-AUDIO":QC_AUDIO_ITEMS.length,
  "QC-PRODUCTION":QC_PRODUCTION_ITEMS.length,"VENUE-SCREEN":VENUE_SCREEN_ITEMS.length,
  "GFX":GFX_ITEMS.length
};
const GAL_SK = {
  "CCSR":"gal_CCSR","CIR":"gal_CIR","MCR":"gal_MCR","INTERCOM":"gal_INTERCOM",
  "FFT":"gal_FFT","RF-CAMS":"gal_RF_CAMS","NOVA-105":"gal_NOVA_105",
  "SL-PRODUCTION":"gal_SL_PRODUCTION","SL-AUDIO":"gal_SL_AUDIO",
  "SM-PRODUCTION":"gal_SM_PRODUCTION","SM-AUDIO":"gal_SM_AUDIO",
  "EIC-AIC":"gal_EIC_AIC","EMG-OFFICE":"gal_EMG_OFFICE",
  "EVS-SL":"gal_EVS_SL","EVS-PC":"gal_EVS_PC",
  "QC-AUDIO":"gal_QC_AUDIO","QC-PRODUCTION":"gal_QC_PRODUCTION",
  "VENUE-SCREEN":"gal_VENUE_SCREEN","GFX":"gal_GFX"
};
function galItemTotal(key){ return GAL_TOTALS[key] || 0; }
function galItemDone(key){
  const sk = GAL_SK[key]; if(!sk) return 0;
  return simpleDone(sk, GAL_TOTALS[key]||0);
}

function setGalStatus(i, sel){
  const val = sel.value;
  sel.className = "status-sel"+(val==="OK"?" s-ok":val==="NOK"?" s-nok":val==="PENDING"?" s-pend":"");
  const d = load(); if(!d.gal) d.gal={};
  if(!d.gal[i]) d.gal[i]={};
  d.gal[i].status = val;
  save(d); refreshAll();
}
function setGalNote(i, ta){
  const d = load(); if(!d.gal) d.gal={};
  if(!d.gal[i]) d.gal[i]={};
  d.gal[i].note = ta.value;
  save(d);
}
function galDone(){ return 0;  }

function buildCamPage(containerId, storageKey, cams){
  const container = document.getElementById(containerId);
  const d = load(); if(!d[storageKey]) d[storageKey]={};
  container.innerHTML="";

  cams.forEach(cam=>{
    const ck=`cam${cam.num}`;
    const cd = d[storageKey][ck]||{};
    const collapsed = cd.collapsed||false;
    const rows = getRows(storageKey, cam.num);
    const checkedN = rows.filter(r=>cd[r]?.checked).length;

    const rowsHTML = rows.map((row,j)=>{
      const rd = cd[row]||{};
      const isDone=rd.checked||false;
      const status=rd.status||"";
      const note=rd.note||"";
      const sc=status==="OK"?"s-ok":status==="NOK"?"s-nok":status==="PENDING"?"s-pend":"";
      return `<div class="cam-row${isDone?' row-done':''}" id="${containerId}-row-${cam.num}-${j}">
        <div class="cam-check-cell">
          <div class="cam-check-box${isDone?' on':''}" onclick="camToggle('${storageKey}',${cam.num},'${row}',${j},'${containerId}',this)">
            <span class="ck">&#10003;</span>
          </div>
        </div>
        <div class="cam-row-label">
          ${row}${rd.ts?`<span class="row-meta">${esc(rd.user||"")}${rd.user?" · ":""}${fmtTime(rd.ts)}</span>`:""}
          ${note?`<span class="cam-note-pill">📝 ${esc(note.length>50?note.slice(0,50)+'…':note)}</span>`:""}
        </div>
        <textarea class="cam-note-input" rows="1" placeholder="Notes…" oninput="camNote('${storageKey}',${cam.num},'${row}',this)">${esc(note)}</textarea>
        <select class="cam-status-sel ${sc}" onchange="camStatus('${storageKey}',${cam.num},'${row}',${j},'${containerId}',this)">
          <option value="">&#8212; status &#8212;</option>
          <option value="OK"      ${status==="OK"?"selected":""}>&#10003; OK</option>
          <option value="NOK"     ${status==="NOK"?"selected":""}>&#10007; NOK</option>
          <option value="PENDING" ${status==="PENDING"?"selected":""}>&#8987; Pending</option>
        </select>
      </div>`;
    }).join("");

    const pillsHTML = pillHtml(storageKey, cam.num);
    const subLine = cam.type ? `<span class="cam-sub">${cam.type} · ${cam.pos}</span>` : "";

    const block = document.createElement("div");
    block.className="cam-block"+(collapsed?" collapsed":"");
    block.id=`${containerId}-block-${cam.num}`;
    block.innerHTML=`
      <div class="cam-header${cam.num===7?" cam-header-rf":""}" onclick="camCollapse('${containerId}',${cam.num})">
        <span class="cam-badge">CAM ${cam.num}</span>
        <span class="cam-name">Camera ${cam.num} ${subLine}</span>
        <span class="cam-pct" id="${containerId}-pct-${cam.num}">${checkedN}/${CAM_ROWS.length}</span>
        <span class="cam-arrow">&#9660;</span>
      </div>
      <div class="cam-body" style="max-height:${collapsed?'0':'9999px'}">
        ${rowsHTML}
        <div class="cam-pills" id="${containerId}-pills-${cam.num}">${pillsHTML}</div>
      </div>`;
    container.appendChild(block);

    const cdCheck = d[storageKey][ck]||{};
    if(getRows(storageKey, cam.num).every(r=>cdCheck[r]?.checked)){
      const hdr = block.querySelector(".cam-header");
      if(hdr) hdr.classList.add("cam-header-done");
    }
  });
}

function pillHtml(sk, camNum){
  const d=load(); const cd=(d[sk]||{})[`cam${camNum}`]||{};
  const rows = CAM_ROWS;
  return rows.map(r=>{
    const s=cd[r]?.status||"";
    const [cls,lbl]=s==="OK"?["p-ok","OK"]:s==="NOK"?["p-nok","NOK"]:s==="PENDING"?["p-pend","…"]:["p-none","—"];
    return `<span class="pill ${cls}">${r}: ${lbl}</span>`;
  }).join("");
}

function checkCamComplete(sk, camNum, cid, d){
  const cd = d[sk][`cam${camNum}`]||{};
  const rows = getRows(sk, camNum);
  const allDone = rows.every(r=>cd[r]?.checked);
  const block = document.getElementById(`${cid}-block-${camNum}`);
  if(!block) return;
  const header = block.querySelector(".cam-header");
  if(allDone){
    header.classList.add("cam-header-done");

    if(!block.classList.contains("collapsed")){
      setTimeout(()=>{
        const body = block.querySelector(".cam-body");
        block.classList.add("collapsed");
        body.style.maxHeight="0";

        const dd=load(); if(!dd[sk]) dd[sk]={}; if(!dd[sk][`cam${camNum}`]) dd[sk][`cam${camNum}`]={};
        dd[sk][`cam${camNum}`].collapsed=true; save(dd);
      }, 400);
    }
  } else {
    header.classList.remove("cam-header-done");
  }
}

function camCollapse(cid, camNum){
  const block=document.getElementById(`${cid}-block-${camNum}`);
  const body=block.querySelector(".cam-body");
  const now=block.classList.toggle("collapsed");
  body.style.maxHeight=now?"0":"9999px";
  const d=load(); const sk=cid.replace(/^list-/,"").replace(/-/g,"_");
  if(!d[sk]) d[sk]={}; if(!d[sk][`cam${camNum}`]) d[sk][`cam${camNum}`]={};
  d[sk][`cam${camNum}`].collapsed=now; save(d);
}

function camToggle(sk, camNum, row, j, cid, boxEl){
  boxEl.classList.toggle("on");
  const isDone=boxEl.classList.contains("on");
  if(isDone){ boxEl.classList.add('check-pop'); setTimeout(()=>boxEl.classList.remove('check-pop'),300); if(window.playCheckTick) playCheckTick(); }
  if(navigator.vibrate) navigator.vibrate(isDone?30:15);
  document.getElementById(`${cid}-row-${camNum}-${j}`).classList.toggle("row-done",isDone);
  const d=load(); if(!d[sk]) d[sk]={}; if(!d[sk][`cam${camNum}`]) d[sk][`cam${camNum}`]={};
  if(!d[sk][`cam${camNum}`][row]) d[sk][`cam${camNum}`][row]={};
  d[sk][`cam${camNum}`][row].checked=isDone;
  const newStatus = isDone ? "OK" : "";
  d[sk][`cam${camNum}`][row].status = newStatus;
  if(isDone){ d[sk][`cam${camNum}`][row].ts=Date.now(); d[sk][`cam${camNum}`][row].user=getCurrentUser(); }
  else { d[sk][`cam${camNum}`][row].ts=null; d[sk][`cam${camNum}`][row].user=null; }
  save(d);

  const selEl = document.querySelector(`#${cid}-row-${camNum}-${j} .cam-status-sel`);
  if(selEl){ selEl.value=newStatus; selEl.className="cam-status-sel"+(isDone?" s-ok":""); }

  const cd=d[sk][`cam${camNum}`]||{};
  const totalRows = camNum === 7 || (camNum === 11 && sk === 'pc') ? 1 : (((camNum >= 12 && camNum <= 15 && sk === 'pc') || (camNum === 10 && sk === 'pc') || (camNum === 18 && sk === 'pc')) ? 3 : ((camNum === 16 || camNum === 17) && sk === 'pc') ? 2 : CAM_ROWS.length);
  const n=Object.keys(cd).filter(r=>cd[r]?.checked).length;
  const pEl=document.getElementById(`${cid}-pct-${camNum}`); if(pEl) pEl.textContent=n+"/"+totalRows;

  const pillEl=document.getElementById(`${cid}-pills-${camNum}`); if(pillEl) pillEl.innerHTML=pillHtml(sk,camNum);

  checkCamComplete(sk, camNum, cid, d);
  refreshAll();
}

function camStatus(sk, camNum, row, j, cid, sel){
  const val=sel.value;
  sel.className="cam-status-sel"+(val==="OK"?" s-ok":val==="NOK"?" s-nok":val==="PENDING"?" s-pend":"");
  const d=load(); if(!d[sk]) d[sk]={}; if(!d[sk][`cam${camNum}`]) d[sk][`cam${camNum}`]={};
  if(!d[sk][`cam${camNum}`][row]) d[sk][`cam${camNum}`][row]={};
  d[sk][`cam${camNum}`][row].status=val;

  const boxEl=document.querySelector(`#${cid}-row-${camNum}-${j} .cam-check-box`);
  const rowEl=document.getElementById(`${cid}-row-${camNum}-${j}`);
  if(val==="OK"){ d[sk][`cam${camNum}`][row].checked=true; if(boxEl) boxEl.classList.add("on"); if(rowEl) rowEl.classList.add("row-done"); }
  else          { d[sk][`cam${camNum}`][row].checked=false; if(boxEl) boxEl.classList.remove("on"); if(rowEl) rowEl.classList.remove("row-done"); }
  save(d);
  const cd=d[sk][`cam${camNum}`]||{};
  const totalRows = camNum === 7 || (camNum === 11 && sk === 'pc') ? 1 : (((camNum >= 12 && camNum <= 15 && sk === 'pc') || (camNum === 10 && sk === 'pc') || (camNum === 18 && sk === 'pc')) ? 3 : ((camNum === 16 || camNum === 17) && sk === 'pc') ? 2 : CAM_ROWS.length);
  const n=Object.keys(cd).filter(r=>cd[r]?.checked).length;
  const pEl=document.getElementById(`${cid}-pct-${camNum}`); if(pEl) pEl.textContent=n+"/"+totalRows;
  const pillEl=document.getElementById(`${cid}-pills-${camNum}`); if(pillEl) pillEl.innerHTML=pillHtml(sk,camNum);
  checkCamComplete(sk, camNum, cid, d);
  refreshAll();
}

function camNote(sk, camNum, row, ta){
  const d=load(); if(!d[sk]) d[sk]={}; if(!d[sk][`cam${camNum}`]) d[sk][`cam${camNum}`]={};
  if(!d[sk][`cam${camNum}`][row]) d[sk][`cam${camNum}`][row]={};
  d[sk][`cam${camNum}`][row].note=ta.value; save(d);
}

function camDone(sk, cams){
  const d=load(); if(!d[sk]) return 0;
  let n=0; cams.forEach(cam=>getRows(sk,cam.num).forEach(r=>{ if(d[sk][`cam${cam.num}`]?.[r]?.checked) n++; })); return n;
}

const POS_CHECKS = ["Monitors","Tablet","Audio","Netjes"];

function buildPosList(containerId, storageKey, positions){
  const container = document.getElementById(containerId);
  if(!container) return;
  const d = load();
  if(!d[storageKey]) d[storageKey] = {};
  container.innerHTML = "";

  positions.forEach(pos => {
    const pd = d[storageKey][pos] || {};
    const collapsed = pd.collapsed || false;
    const doneN = POS_CHECKS.filter(c => pd[c]).length;
    const allDone = doneN === POS_CHECKS.length;

    const section = document.createElement("div");
    section.className = "pos-section" + (collapsed ? " collapsed" : "");
    section.id = `${containerId}-pos-${pos}`;

    const rowsHTML = POS_CHECKS.map((chk, j) => {
      const isDone = pd[chk] || false;
      const note = pd[chk+"_note"] || "";
      const posMeta = (isDone && (pd[chk+"_user"]||pd[chk+"_ts"])) ? esc(pd[chk+"_user"]||"")+(pd[chk+"_user"]&&pd[chk+"_ts"]?" · ":"")+fmtTime(pd[chk+"_ts"]||null) : "";
      return `<div class="pos-row${isDone ? " row-done" : ""}" id="${containerId}-posrow-${pos}-${j}">
        <div class="pos-row-left" onclick="posToggle('${storageKey}','${pos}',${j},'${containerId}',document.getElementById('${containerId}-posrow-${pos}-${j}'))">
          <div class="pos-check-box${isDone ? " on" : ""}"><span class="ck">&#10003;</span></div>
          <div>
            <span class="pos-row-label">${chk}</span>
            ${posMeta ? `<span class="row-meta">${posMeta}</span>` : ""}
          </div>
        </div>
        <textarea class="pos-note-input" placeholder="Notes…" oninput="posNote('${storageKey}','${pos}','${chk}',this)">${esc(note)}</textarea>
      </div>`;
    }).join("");

    section.innerHTML = `
      <div class="pos-header${allDone ? " pos-done" : ""}" onclick="posCollapse('${containerId}','${pos}')">
        <span class="pos-badge">${pos}</span>
        <span class="pos-title-wrap">
          <span class="pos-title">${pos}</span>
          <input class="pos-subtitle" type="text" placeholder="achtertitel…" value="${pd.subtitle||''}" onclick="event.stopPropagation()" oninput="posSubtitle('${storageKey}','${pos}',this)">
        </span>
        <span class="pos-pct" id="${containerId}-pospct-${pos}">${doneN}/${POS_CHECKS.length}</span>
        <span class="pos-arrow">&#9660;</span>
      </div>
      <div class="pos-body" style="max-height:${collapsed ? "0" : "9999px"}">
        ${rowsHTML}
      </div>`;
    container.appendChild(section);
  });
}

function posToggle(sk, pos, j, cid, rowEl){
  const boxEl = rowEl.querySelector(".pos-check-box");
  boxEl.classList.toggle("on");
  const isDone = boxEl.classList.contains("on");
  if(isDone){ boxEl.classList.add('check-pop'); setTimeout(()=>boxEl.classList.remove('check-pop'),300); if(window.playCheckTick) playCheckTick(); }
  if(navigator.vibrate) navigator.vibrate(isDone?30:15);
  rowEl.classList.toggle("row-done", isDone);
  const chk = POS_CHECKS[j];
  const d = load();
  if(!d[sk]) d[sk] = {};
  if(!d[sk][pos]) d[sk][pos] = {};
  d[sk][pos][chk] = isDone;
  if(isDone){ d[sk][pos][chk+"_ts"]=Date.now(); d[sk][pos][chk+"_user"]=getCurrentUser(); }
  else { d[sk][pos][chk+"_ts"]=null; d[sk][pos][chk+"_user"]=null; }
  save(d);
  const pd = d[sk][pos] || {};
  const doneN = POS_CHECKS.filter(c => pd[c]).length;
  const pEl = document.getElementById(`${cid}-pospct-${pos}`);
  if(pEl) pEl.textContent = doneN + "/" + POS_CHECKS.length;

  const allDone = doneN === POS_CHECKS.length;
  const hdr = document.querySelector(`#${cid}-pos-${pos} .pos-header`);
  if(hdr){ allDone ? hdr.classList.add("pos-done") : hdr.classList.remove("pos-done"); }
  if(allDone){
    const block = document.getElementById(`${cid}-pos-${pos}`);
    if(block && !block.classList.contains("collapsed")){
      setTimeout(()=>{
        const body = block.querySelector(".pos-body");
        block.classList.add("collapsed");
        body.style.maxHeight = "0";
        const dd = load(); if(!dd[sk]) dd[sk]={}; if(!dd[sk][pos]) dd[sk][pos]={};
        dd[sk][pos].collapsed = true; save(dd);
      }, 400);
    }
  }
  refreshAll();
}

function posSubtitle(sk, pos, inp){
  const d = load();
  if(!d[sk]) d[sk] = {};
  if(!d[sk][pos]) d[sk][pos] = {};
  d[sk][pos].subtitle = inp.value;
  save(d);
}

function posNote(sk, pos, chk, ta){
  const d = load();
  if(!d[sk]) d[sk] = {};
  if(!d[sk][pos]) d[sk][pos] = {};
  d[sk][pos][chk+"_note"] = ta.value;
  save(d);
}

function posCollapse(cid, pos){
  const block = document.getElementById(`${cid}-pos-${pos}`);
  const body = block.querySelector(".pos-body");
  const now = block.classList.toggle("collapsed");
  body.style.maxHeight = now ? "0" : "9999px";
  const sk = cid.replace(/^list-/, "").replace(/-/g, "_");
  const d = load(); if(!d[sk]) d[sk]={}; if(!d[sk][pos]) d[sk][pos]={};
  d[sk][pos].collapsed = now; save(d);
}

function posDone(sk, positions){
  const d = load(); if(!d[sk]) return 0;
  let n = 0;
  positions.forEach(pos => POS_CHECKS.forEach(c => { if(d[sk][pos]?.[c]) n++; }));
  return n;
}

const PC4TH_POSITIONS = ['403', '404', '405', '406', '407', '408', '409', '410', '411', '412', '413', '414'];
const PC5TH_POSITIONS = ['501','502','503','504','505','506'];
const COMMSL_POSITIONS = ['306','307','308','309'];
const COMMSM_POSITIONS = ['TV1','TV2','TV3'];

function buildSimpleList(containerId, storageKey, items){
  const container = document.getElementById(containerId);
  if(!container) return;
  const d = load();
  if(!d[storageKey]) d[storageKey] = {};
  container.innerHTML = `<div class="simple-list" id="${containerId}-list">` +
    items.map((name, i) => {
      const entry  = d[storageKey][i] || {};
      const isDone = entry.checked || false;
      const note   = entry.note || "";
      const sMeta = (isDone && (entry.user||entry.ts)) ? (entry.user||"")+(entry.user&&entry.ts?" · ":"")+fmtTime(entry.ts||null) : "";
      return `<div class="simple-row${isDone ? " row-done" : ""}" id="${containerId}-srow-${i}">
        <div class="simple-check${isDone ? " on" : ""}" onclick="simpleToggle('${storageKey}',${i},'${containerId}',this)"><span class="ck">&#10003;</span></div>
        <div class="simple-label-wrap" onclick="simpleToggle('${storageKey}',${i},'${containerId}',document.querySelector('#${containerId}-srow-${i} .simple-check'))">
          <span class="simple-label">${name}</span>
          <span class="row-meta" id="${containerId}-smeta-${i}">${sMeta}</span>
        </div>
        <textarea class="simple-note" placeholder="Notes…" oninput="simpleNote('${storageKey}',${i},this)">${esc(note)}</textarea>
      </div>`;
    }).join("") +
  `</div>`;

}

function simpleToggle(sk, i, cid, boxEl){
  boxEl.classList.toggle("on");
  const isDone = boxEl.classList.contains("on");
  if(isDone){ boxEl.classList.add('check-pop'); setTimeout(()=>boxEl.classList.remove('check-pop'),300); if(window.playCheckTick) playCheckTick(); }
  if(navigator.vibrate) navigator.vibrate(isDone?30:15);
  const rowEl = document.getElementById(`${cid}-srow-${i}`);
  if(rowEl) rowEl.classList.toggle("row-done", isDone);
  const d = load();
  if(!d[sk]) d[sk] = {};
  if(!d[sk][i]) d[sk][i] = {};
  d[sk][i].checked = isDone;
  if(isDone){ d[sk][i].ts=Date.now(); d[sk][i].user=getCurrentUser(); }
  else { d[sk][i].ts=null; d[sk][i].user=null; }
  save(d);

  const metaEl = document.getElementById(`${cid}-smeta-${i}`);
  if(metaEl) metaEl.textContent = isDone ? (getCurrentUser()?getCurrentUser()+" · ":"")+fmtTime(Date.now()) : "";
  refreshAll();
}

function simpleNote(sk, i, ta){
  const d = load();
  if(!d[sk]) d[sk] = {};
  if(!d[sk][i]) d[sk][i] = {};
  d[sk][i].note = ta.value;
  save(d);
}

function simpleDone(sk, total){
  const d = load();
  if(!d[sk]) return 0;
  let n = 0;
  for(let i = 0; i < total; i++){ if(d[sk][i]?.checked) n++; }
  return n;
}

const CAM_ROW_OVERRIDES = {
  "c14": { 1: ["FIBERS","SMPTE","CAMERA"], 7: ["CAMERA"] },
  "pc":  {
    7:  ["CAMERA"],
    10: ["FIBERS","SMPTE","CAMERA"],
    11: ["CAMERA"],
    12: ["FIBERS","CAMERA"],
    13: ["FIBERS","CAMERA"],
    14: ["FIBERS","SMPTE","CAMERA"],
    15: ["FIBERS","SMPTE","CAMERA"],
    16: ["FIBERS","CAMERA"],
    17: ["FIBERS","CAMERA"],
    18: ["FIBERS","CAMERA"],
    20: ["CAMERA"]
  },
  "sl":  {
    7:  ["CAMERA"],
    10: ["FIBERS","SMPTE","CAMERA"],
    11: ["CAMERA"],
    12: ["FIBERS","CAMERA"],
    13: ["FIBERS","CAMERA"],
    14: ["FIBERS","SMPTE","CAMERA"],
    15: ["FIBERS","SMPTE","CAMERA"],
    16: ["FIBERS","CAMERA"],
    17: ["FIBERS","CAMERA"],
    18: ["FIBERS","CAMERA"]
  },
  "sm":  {
    7:  ["CAMERA"],
    8:  ["FIBERS","CAMERA"],
    9:  ["FIBERS","CAMERA"],
    10: ["FIBERS","CAMERA"],
    11: ["FIBERS","CAMERA"]
  }
};
function getRows(sk, camNum){
  return (CAM_ROW_OVERRIDES[sk] && CAM_ROW_OVERRIDES[sk][camNum]) || CAM_ROWS;
}

const SECTIONS = [
  { key:"courts", listId:"list-courts", cams:null,
    total:()=>["pc","sl","sm","c14"].reduce((t,sk)=>t+(sk==="pc"?PC_CAMS:sk==="sl"?SL_CAMS:sk==="sm"?SM_CAMS:C14_CAMS).reduce((s,c)=>s+getRows(sk,c.num).length,0),0),
    done:()=>camDone("pc",PC_CAMS)+camDone("sl",SL_CAMS)+camDone("sm",SM_CAMS)+camDone("c14",C14_CAMS) },
  { key:"audio", listId:null, cams:null,
    total:()=>PC_MIC_ITEMS.length+SL_MIC_ITEMS.length+SM_MIC_ITEMS.length+C14_MIC_ITEMS.length+PC_SB_ITEMS.length+SL_SB_ITEMS.length+SM_SB_ITEMS.length+C14_SB_ITEMS.length,
    done:()=>simpleDone("audio_pc",PC_MIC_ITEMS.length)+simpleDone("audio_sl",SL_MIC_ITEMS.length)+simpleDone("audio_sm",SM_MIC_ITEMS.length)+simpleDone("audio_c14",C14_MIC_ITEMS.length)+simpleDone("sb_pc",PC_SB_ITEMS.length)+simpleDone("sb_sl",SL_SB_ITEMS.length)+simpleDone("sb_sm",SM_SB_ITEMS.length)+simpleDone("sb_c14",C14_SB_ITEMS.length) },
  { key:"comm",       listId:"list-comm",      cams:null,       total:()=>PC4TH_POSITIONS.length*POS_CHECKS.length+PC5TH_POSITIONS.length*POS_CHECKS.length+COMMSL_POSITIONS.length*POS_CHECKS.length+COMMSM_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_pc4th",PC4TH_POSITIONS)+posDone("comm_pc5th",PC5TH_POSITIONS)+posDone("comm_sl",COMMSL_POSITIONS)+posDone("comm_sm",COMMSM_POSITIONS) },
  { key:"gal",        listId:null,             cams:null,       total:()=>CCSR_ITEMS.length+CIR_ITEMS.length+MCR_ITEMS.length+INTERCOM_ITEMS.length+FFT_ITEMS.length+RF_CAMS_ITEMS.length+NOVA_105_ITEMS.length+SL_PRODUCTION_ITEMS.length+SL_AUDIO_ITEMS.length+SM_PRODUCTION_ITEMS.length+SM_AUDIO_ITEMS.length+EIC_AIC_ITEMS.length+EMG_OFFICE_ITEMS.length+EVS_SL_ITEMS.length+EVS_PC_ITEMS.length+QC_AUDIO_ITEMS.length+QC_PRODUCTION_ITEMS.length+VENUE_SCREEN_ITEMS.length+GFX_ITEMS.length,
    done:()=>simpleDone("gal_CCSR",CCSR_ITEMS.length)+simpleDone("gal_CIR",CIR_ITEMS.length)+simpleDone("gal_MCR",MCR_ITEMS.length)+simpleDone("gal_INTERCOM",INTERCOM_ITEMS.length)+simpleDone("gal_FFT",FFT_ITEMS.length)+simpleDone("gal_RF_CAMS",RF_CAMS_ITEMS.length)+simpleDone("gal_NOVA_105",NOVA_105_ITEMS.length)+simpleDone("gal_SL_PRODUCTION",SL_PRODUCTION_ITEMS.length)+simpleDone("gal_SL_AUDIO",SL_AUDIO_ITEMS.length)+simpleDone("gal_SM_PRODUCTION",SM_PRODUCTION_ITEMS.length)+simpleDone("gal_SM_AUDIO",SM_AUDIO_ITEMS.length)+simpleDone("gal_EIC_AIC",EIC_AIC_ITEMS.length)+simpleDone("gal_EMG_OFFICE",EMG_OFFICE_ITEMS.length)+simpleDone("gal_EVS_SL",EVS_SL_ITEMS.length)+simpleDone("gal_EVS_PC",EVS_PC_ITEMS.length)+simpleDone("gal_QC_AUDIO",QC_AUDIO_ITEMS.length)+simpleDone("gal_QC_PRODUCTION",QC_PRODUCTION_ITEMS.length)+simpleDone("gal_VENUE_SCREEN",VENUE_SCREEN_ITEMS.length)+simpleDone("gal_GFX",GFX_ITEMS.length) },
  { key:"c14",        listId:null,             cams:C14_CAMS,   total:()=>C14_CAMS.reduce((s,c)=>s+getRows("c14",c.num).length,0), done:()=>camDone("c14",C14_CAMS) },
  { key:"pc", listId:null, cams:null, total:()=>PC_CAMS.reduce((s,c)=>s+getRows("pc",c.num).length,0), done:()=>camDone("pc",PC_CAMS) },
  { key:"sl", listId:null, cams:null, total:()=>SL_CAMS.reduce((s,c)=>s+getRows("sl",c.num).length,0), done:()=>camDone("sl",SL_CAMS) },
  { key:"sm", listId:null, cams:null, total:()=>SM_CAMS.reduce((s,c)=>s+getRows("sm",c.num).length,0), done:()=>camDone("sm",SM_CAMS) },
  { key:"comm_pc4th", listId:null, cams:null, total:()=>PC4TH_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_pc4th",PC4TH_POSITIONS) },
  { key:"comm_pc5th", listId:null, cams:null, total:()=>PC5TH_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_pc5th",PC5TH_POSITIONS) },
  { key:"comm_sl",    listId:null, cams:null, total:()=>COMMSL_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_sl",COMMSL_POSITIONS) },
  { key:"comm_sm",    listId:null, cams:null, total:()=>COMMSM_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_sm",COMMSM_POSITIONS) },
];

function pct(d,t){ return t?Math.round(d/t*100):0; }
function bar(id,p){ const el=document.getElementById(id); if(el&&el.style.width!==p+"%") el.style.width=p+"%"; }
function txt(id,v){ const el=document.getElementById(id); if(el&&el.textContent!==String(v)) el.textContent=v; }

function refreshCounters(){
  const totals={}, dones={};
  SECTIONS.forEach(s=>{ totals[s.key]=s.total(); dones[s.key]=s.done(); });
  const TOP_KEYS = ["courts","audio","comm","gal"];
  const gT = TOP_KEYS.reduce((a,k)=>a+(totals[k]||0),0);
  const gD = TOP_KEYS.reduce((a,k)=>a+(dones[k]||0),0);
  bar("home-bar", pct(gD,gT)); txt("home-lbl",gD+" / "+gT);
  txt("home-done",gD); txt("home-left",gT-gD); txt("home-pct",pct(gD,gT)+"%");
  bar("pc-bar", pct(dones.pc,totals.pc)); txt("count-pc",dones.pc+"/"+totals.pc); txt("chip-pc",dones.pc+"/"+totals.pc);
  bar("sl-bar", pct(dones.sl,totals.sl)); txt("count-sl",dones.sl+"/"+totals.sl); txt("chip-sl",dones.sl+"/"+totals.sl);
  bar("sm-bar", pct(dones.sm,totals.sm)); txt("count-sm",dones.sm+"/"+totals.sm); txt("chip-sm",dones.sm+"/"+totals.sm);
  bar("c14-bar",pct(dones.c14,totals.c14)); txt("count-c14",dones.c14+"/"+totals.c14); txt("chip-c14",dones.c14+"/"+totals.c14);
  bar("comm-bar",pct(dones.comm,totals.comm)); txt("comm-count",dones.comm+"/"+totals.comm);
  bar("gal-bar", pct(dones.gal,totals.gal)); txt("gal-count",dones.gal+"/"+totals.gal);
}

let _rafPending = false;
function refreshAll(){
  if(_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(()=>{ _rafPending=false; _doRefresh(); });
}
window.refreshAll = refreshAll;
function _doRefresh(){
  refreshAudioCounters();

  const totals={}, dones={};
  SECTIONS.forEach(s=>{ totals[s.key]=s.total(); dones[s.key]=s.done(); });

  bar("courts-bar", pct(dones.courts,totals.courts)); txt("courts-lbl",dones.courts+"/"+totals.courts); txt("courts-count",dones.courts+"/"+totals.courts); txt("tab-camera-count",dones.courts+"/"+totals.courts); txt("sel-camera-count",dones.courts+"/"+totals.courts+" voltooid"); bar("sel-camera-bar", pct(dones.courts,totals.courts));

  bar("comm-bar",   pct(dones.comm,totals.comm));     txt("comm-lbl",dones.comm+"/"+totals.comm);       txt("comm-count",dones.comm+"/"+totals.comm);

  bar("gal-bar",    pct(dones.gal,totals.gal));       txt("gal-lbl",dones.gal+"/"+totals.gal);         txt("gal-count",dones.gal+"/"+totals.gal);
  const galMsg=document.getElementById("gal-done-msg"); if(galMsg) dones.gal===totals.gal&&totals.gal>0?galMsg.classList.add("visible"):galMsg.classList.remove("visible");

  ['CCSR', 'CIR', 'MCR', 'INTERCOM', 'FFT', 'RF-CAMS', 'NOVA-105', 'SL-PRODUCTION', 'SL-AUDIO', 'SM-PRODUCTION', 'SM-AUDIO', 'EIC-AIC', 'EMG-OFFICE', 'EVS-SL', 'EVS-PC', 'QC-AUDIO', 'QC-PRODUCTION', 'VENUE-SCREEN', 'GFX'].forEach(key=>{
    const d=galItemDone(key), t=galItemTotal(key);
    txt("gal-note-"+key, d+" van "+t+" voltooid");
    txt("gal-pct-"+key, d+"/"+t);
  });

  bar("c14-bar",    pct(dones.c14,totals.c14));       txt("c14-lbl",dones.c14+"/"+totals.c14);         txt("count-c14",dones.c14+"/"+totals.c14);
  const c14Msg=document.getElementById("c14-done-msg"); if(c14Msg) dones.c14===totals.c14&&totals.c14>0?c14Msg.classList.add("visible"):c14Msg.classList.remove("visible");
  txt("chip-c14",dones.c14+"/"+totals.c14); txt("c14-note-label",dones.c14+" van "+totals.c14+" voltooid");

  bar("pc-bar",     pct(dones.pc,totals.pc));  txt("pc-lbl",dones.pc+"/"+totals.pc);   txt("count-pc",dones.pc+"/"+totals.pc);  txt("chip-pc",dones.pc+"/"+totals.pc);  txt("pc-note-label",dones.pc+" van "+totals.pc+" voltooid");
  bar("sl-bar",     pct(dones.sl,totals.sl));  txt("sl-lbl",dones.sl+"/"+totals.sl);   txt("count-sl",dones.sl+"/"+totals.sl);  txt("chip-sl",dones.sl+"/"+totals.sl);  txt("sl-note-label",dones.sl+" van "+totals.sl+" voltooid");
  bar("sm-bar",     pct(dones.sm,totals.sm));  txt("sm-lbl",dones.sm+"/"+totals.sm);   txt("count-sm",dones.sm+"/"+totals.sm);  txt("chip-sm",dones.sm+"/"+totals.sm);  txt("sm-note-label",dones.sm+" van "+totals.sm+" voltooid");

  [["pc4th"],["pc5th"],["sl"],["sm"]].forEach(([k])=>{
    const sk="comm_"+k, d=dones[sk]||0, t=totals[sk]||0, p=pct(d,t);
    bar(`comm-${k}-bar`,p); txt(`comm-${k}-lbl`,d+"/"+t); txt(`count-comm-${k}`,d+"/"+t);
    txt(`chip-comm-${k}`,d+"/"+t);
    txt(`comm-${k}-note`,d+" van "+t+" voltooid");
  });

  const pc4thD=dones["comm_pc4th"]||0, pc4thT=totals["comm_pc4th"]||0;
  txt("comm-pc4th-note",pc4thD+" van "+pc4thT+" voltooid");

  buildDash(totals, dones);

  const TOP_KEYS = ["courts","audio","comm","gal"];
  const gT = TOP_KEYS.reduce((a,k)=>a+(totals[k]||0),0);
  const gD = TOP_KEYS.reduce((a,k)=>a+(dones[k]||0),0);
  const gP = pct(gD,gT);
  bar("home-bar",gP); txt("home-lbl",gD+" / "+gT);
  txt("home-done",gD); txt("home-left",gT-gD); txt("home-pct",gP+"%");
  const hMsg=document.getElementById("home-done-msg"); if(hMsg) gD===gT&&gT>0?hMsg.classList.add("visible"):hMsg.classList.remove("visible");
  if(document.getElementById('page-problems')?.classList.contains('active')) buildProblems();
}

const DASH_CARDS = [
  { label:"Courts",      icon:"🎾", page:"page-courts-select", key:"courts", keys:["courts","audio"] },
  { label:"Commentaar",  icon:"🎙️", page:"page-commentaar", key:"comm" },
  { label:"Gallery's",  icon:"🖼️", page:"page-galleries",  key:"gal" },
];

function buildDash(totals, dones){
  const grid=document.getElementById("dash-grid");
  // Bouw structuur eenmalig; daarna alleen waarden updaten
  if(!grid._built){
    grid.innerHTML="";
    DASH_CARDS.forEach(card=>{
      const div=document.createElement("div");
      div.className="dash-card";
      div.style.borderLeftWidth="4px";
      div.onclick=()=>goTo(card.page);
      div.innerHTML=`
        <div class="dash-card-icon">${card.icon}</div>
        <div class="dash-card-title">${card.label}</div>
        <div class="dash-card-track"><div class="dash-card-fill" id="dc-bar-${card.key}"></div></div>
        <div class="dash-card-footer">
          <span class="dash-card-count" id="dc-count-${card.key}"></span>
          <span class="dash-card-pct" id="dc-pct-${card.key}" style="opacity:.8"></span>
        </div>`;
      grid.appendChild(div);
      div._card = card;
    });
    grid._built = true;
  }
  // Update alleen de dynamische waarden
  Array.from(grid.children).forEach(div=>{
    const card = div._card;
    const keys = card.keys || [card.key];
    const t=keys.reduce((a,k)=>a+(totals[k]||0),0), d=keys.reduce((a,k)=>a+(dones[k]||0),0), p=pct(d,t);
    const color = p===100?"#2D5A1B":p>=50?"#C1440E":"#8B2E07";
    div.style.borderLeftColor = color;
    bar("dc-bar-"+card.key, p);
    txt("dc-count-"+card.key, d+" / "+t);
    const pctEl = document.getElementById("dc-pct-"+card.key);
    if(pctEl){ pctEl.textContent=p+"%"; pctEl.style.color=color; }
  });
}

function exportToExcel(){
  closeAdminModal();
  if(window._loadXLSX){ window._loadXLSX(_doExportToExcel); return; } _doExportToExcel();
}
function _doExportToExcel(){
  if(typeof XLSX === "undefined"){ alert("Excel library niet geladen. Controleer je internetverbinding."); return; }

  const d = load();
  const wb = XLSX.utils.book_new();
  const now = new Date();
  const dateStr = now.toLocaleDateString("nl-NL") + " " + now.toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"});

  function makeWS(headers, rows, title){
    const data = [
      [title + " — Export: " + dateStr],
      [],
      headers,
      ...rows
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);

    ws["!cols"] = headers.map((_,i) => ({ wch: i===0?12 : i===1?28 : i===2?18 : i===3?10 : 14 }));

    ws["!merges"] = [{ s:{r:0,c:0}, e:{r:0,c:headers.length-1} }];
    return ws;
  }

  const courtMap = { c14:C14_CAMS, pc:PC_CAMS, sl:SL_CAMS, sm:SM_CAMS };
  const courtLabels = { c14:"C14", pc:"Philippe-Chatrier", sl:"Suzanne-Lenglen", sm:"Simonne-Mathieu" };

  for(const [sk, cams] of Object.entries(courtMap)){
    const rows = [];
    cams.forEach(cam => {
      getRows(sk, cam.num).forEach(row => {
        const rd = (d[sk]||{})[`cam${cam.num}`]?.[row] || {};
        rows.push([
          "CAM " + cam.num,
          cam.name || "",
          row,
          rd.checked ? "✓" : "✗"
        ]);
      });
    });
    const ws = makeWS(["CAM","Positie","Check","Status"], rows, courtLabels[sk]);
    XLSX.utils.book_append_sheet(wb, ws, courtLabels[sk].substring(0,31));
  }

  const commRows = [];
  const commMap = {
    comm_pc4th: { pos: PC4TH_POSITIONS, lbl: "PC 4TH" },
    comm_pc5th: { pos: PC5TH_POSITIONS, lbl: "PC 5TH" },
    comm_sl:    { pos: COMMSL_POSITIONS, lbl: "SL" },
    comm_sm:    { pos: COMMSM_POSITIONS, lbl: "SM" }
  };
  for(const [sk, {pos, lbl}] of Object.entries(commMap)){
    pos.forEach(p => {
      POS_CHECKS.forEach(chk => {
        const pd = (d[sk]||{})[p] || {};
        commRows.push([ lbl, p, chk, pd[chk] ? "✓" : "✗" ]);
      });
    });
  }
  const wsComm = makeWS(["Box","Positie","Check","Status"], commRows, "Commentaar");
  XLSX.utils.book_append_sheet(wb, wsComm, "Commentaar");

  const galRows = [];
  const galExportMap = [
    ["CCSR",CCSR_ITEMS,"gal_CCSR"],["CIR",CIR_ITEMS,"gal_CIR"],["MCR",MCR_ITEMS,"gal_MCR"],
    ["INTERCOM",INTERCOM_ITEMS,"gal_INTERCOM"],["FFT",FFT_ITEMS,"gal_FFT"],
    ["RF-CAMS",RF_CAMS_ITEMS,"gal_RF_CAMS"],["NOVA-105",NOVA_105_ITEMS,"gal_NOVA_105"],
    ["SL-PRODUCTION",SL_PRODUCTION_ITEMS,"gal_SL_PRODUCTION"],["SL-AUDIO",SL_AUDIO_ITEMS,"gal_SL_AUDIO"],
    ["SM-PRODUCTION",SM_PRODUCTION_ITEMS,"gal_SM_PRODUCTION"],["SM-AUDIO",SM_AUDIO_ITEMS,"gal_SM_AUDIO"],
    ["EIC-AIC",EIC_AIC_ITEMS,"gal_EIC_AIC"],["EMG-OFFICE",EMG_OFFICE_ITEMS,"gal_EMG_OFFICE"],
    ["EVS-SL",EVS_SL_ITEMS,"gal_EVS_SL"],["EVS-PC",EVS_PC_ITEMS,"gal_EVS_PC"],
    ["QC-AUDIO",QC_AUDIO_ITEMS,"gal_QC_AUDIO"],["QC-PRODUCTION",QC_PRODUCTION_ITEMS,"gal_QC_PRODUCTION"],
    ["VENUE-SCREEN",VENUE_SCREEN_ITEMS,"gal_VENUE_SCREEN"],["GFX",GFX_ITEMS,"gal_GFX"]
  ];
  galExportMap.forEach(([label,items,sk])=>{
    items.forEach((name,i)=>{
      const e = (d[sk]||{})[i]||{};
      galRows.push([label, name, e.checked ? "✓" : "✗"]);
    });
  });
  const wsGal = makeWS(["Gallery","Item","Status"], galRows, "Gallery's");
  XLSX.utils.book_append_sheet(wb, wsGal, "Gallery's");

  const filename = "RG2026_Status_" + now.toLocaleDateString("nl-NL").replace(/\//g,"-") + ".xlsx";
  XLSX.writeFile(wb, filename);
}

const DEFAULT_USERS = ["Jules","Robin","Aaron","Jarno","Rosan","Anne-gert","Gaëlle","OPL","Pim","Remco","Peter","Emil","Damian"];

// Zorg dat alle DEFAULT_USERS altijd in de opgeslagen lijst staan.
// Wordt aangeroepen ná de eerste Supabase-sync zodat remote niet wint.
function seedDefaultUsers(){
  try {
    const d = load();
    const current = d._users && d._users.length ? d._users : [];
    const missing = DEFAULT_USERS.filter(u => !current.map(x=>x.toLowerCase()).includes(u.toLowerCase()));
    if(missing.length > 0) saveUsers([...current, ...missing]);
  } catch(e){}
}

window.rebuildNameDropdown = rebuildNameDropdown;


let presenceChannel = null;

function initPresence(){
  const client = window._supaClient;
  if(!client) return;
  if(presenceChannel) return; // al actief
  const user = getCurrentUser() || "Onbekend";

  presenceChannel = client.channel("rg-presence", {
    config: { presence: { key: user } }
  });

  presenceChannel
    .on("presence", { event: "sync" }, ()=>{
      updateOnlineList();
    })
    .subscribe(async status=>{
      if(status === "SUBSCRIBED"){
        await presenceChannel.track({ user, since: Date.now() });
      }
    });
}

function updateOnlineList(){
  if(!presenceChannel) return;
  const state = presenceChannel.presenceState();
  const users = Object.values(state).flat().map(p=>p.user).filter(Boolean);
  const el = document.getElementById("online-users-list");
  if(!el) return;
  if(users.length === 0){
    el.textContent = "Niemand online";
  } else {
    el.innerHTML = users.map(u=>`<span style="display:inline-block;background:rgba(45,90,27,.15);border-radius:4px;padding:2px 8px;margin:2px 3px 2px 0;font-size:11px;">👤 ${esc(u)}</span>`).join("");
  }
}

function toggleDark(){
  const html = document.documentElement;
  const isDark = html.getAttribute("data-theme")==="dark";
  html.setAttribute("data-theme", isDark ? "light" : "dark");
  localStorage.setItem("rg_theme", isDark ? "light" : "dark");
  const btn = document.querySelector(".dark-toggle");
  if(btn) btn.textContent = isDark ? "🌙" : "☀️";
}

function saveFirebaseConfig(){
  const url = document.getElementById("fb-url")?.value.trim();
  const key = document.getElementById("fb-key")?.value.trim();
  if(!url||!key){ alert("Vul beide velden in."); return; }
  localStorage.setItem("rg_fb_config", JSON.stringify({url, key}));
  if(window.initSupabase) window.initSupabase(url, key);
  const el = document.getElementById("sync-status");
  if(el){ el.textContent="✅ Verbonden"; el.style.color="#2D5A1B"; }
}


function openAdminModal(){
  const modal = document.getElementById("admin-modal");
  const loginSection = document.getElementById("admin-login-section");
  const panel = document.getElementById("admin-panel");
  const err = document.getElementById("admin-error");
  const input = document.getElementById("admin-pw-input");

  if(loginSection) loginSection.style.display = "block";
  if(panel) panel.style.display = "none";
  if(err) err.style.display = "none";
  if(input) { input.value = ""; }
  modal.classList.add("open");
  setTimeout(()=>{ if(input) input.focus(); }, 100);

  if(!presenceChannel) initPresence();
  setTimeout(updateOnlineList, 300);
}

function closeAdminModal(e){
  if(e && e.target !== document.getElementById("admin-modal")) return;
  document.getElementById("admin-modal").classList.remove("open");
}

async function checkAdminPw(){
  const input = document.getElementById("admin-pw-input");
  const err   = document.getElementById("admin-error");
  const loginSection = document.getElementById("admin-login-section");
  const panel = document.getElementById("admin-panel");

  if(!window._SUPABASE_URL){ err.style.display = "block"; return; }

  // Gebruik een aparte tijdelijke client zodat de hoofdsessie intact blijft
  const tempClient = supabase.createClient(window._SUPABASE_URL, window._SUPABASE_KEY);
  const { error } = await tempClient.auth.signInWithPassword({
    email: ADMIN_AUTH_EMAIL,
    password: input.value
  });

  if(!error){
    loginSection.style.display = "none";
    panel.style.display = "block";
    err.style.display = "none";
  } else {
    err.style.display = "block";
    input.value = "";
    input.focus();
    input.style.borderColor = "var(--clay)";
    setTimeout(()=>{ input.style.borderColor = ""; }, 1000);
  }
}

function buildActivity(){
  const wrap = document.getElementById('activity-log');
  if(!wrap) return;
  const d = load();
  const filterEl = document.getElementById('activity-filter');
  const onlyToday = !filterEl || filterEl.value === 'today';
  const todayStr = new Date().toISOString().slice(0,10);

  const events = [];

  const courtLabels = { pc:'Philippe-Chatrier', sl:'Suzanne-Lenglen', sm:'Simonne-Mathieu', c14:'Court 14' };

  // Camera
  for(const [sk, lbl] of Object.entries(courtLabels)){
    const sect = d[sk]||{};
    for(const camKey of Object.keys(sect)){
      const cd = sect[camKey];
      if(typeof cd !== 'object') continue;
      for(const row of Object.keys(cd)){
        const rd = cd[row];
        if(rd?.checked && rd.ts) events.push({ ts:rd.ts, user:rd.user||'—', label:row, section:`📷 ${lbl} · ${camKey.replace('cam','CAM ')}` });
      }
    }
  }

  // Audio + Stageboxes
  const audioMap = [
    {key:'audio_pc',items:PC_MIC_ITEMS,lbl:'🎙 Audio PC'},
    {key:'audio_sl',items:SL_MIC_ITEMS,lbl:'🎙 Audio SL'},
    {key:'audio_sm',items:SM_MIC_ITEMS,lbl:'🎙 Audio SM'},
    {key:'audio_c14',items:C14_MIC_ITEMS,lbl:'🎙 Audio C14'},
    {key:'sb_pc',items:PC_SB_ITEMS,lbl:'📦 Stageboxes PC'},
    {key:'sb_sl',items:SL_SB_ITEMS,lbl:'📦 Stageboxes SL'},
    {key:'sb_sm',items:SM_SB_ITEMS,lbl:'📦 Stageboxes SM'},
    {key:'sb_c14',items:C14_SB_ITEMS,lbl:'📦 Stageboxes C14'},
  ];
  for(const {key,items,lbl} of audioMap){
    const sect = d[key]||{};
    items.forEach((name,i)=>{ const e=sect[i]; if(e?.checked&&e.ts) events.push({ts:e.ts,user:e.user||'—',label:name,section:lbl}); });
  }

  // Comm
  const commMap = { comm_pc4th:{pos:PC4TH_POSITIONS,lbl:'🎙 Comm PC 4th'}, comm_pc5th:{pos:PC5TH_POSITIONS,lbl:'🎙 Comm PC 5th'}, comm_sl:{pos:COMMSL_POSITIONS,lbl:'🎙 Comm SL'}, comm_sm:{pos:COMMSM_POSITIONS,lbl:'🎙 Comm SM'} };
  for(const [sk,{pos,lbl}] of Object.entries(commMap)){
    pos.forEach(p=>{ POS_CHECKS.forEach(chk=>{ const pd=(d[sk]||{})[p]||{}; if(pd[chk]&&pd[chk+'_ts']) events.push({ts:pd[chk+'_ts'],user:pd[chk+'_user']||'—',label:chk,section:`${lbl} · ${p}`}); }); });
  }

  // Gallery
  const galMap = [
    {key:'gal_CCSR',items:CCSR_ITEMS,lbl:'🖼 CCSR'},{key:'gal_CIR',items:CIR_ITEMS,lbl:'🖼 CIR'},
    {key:'gal_MCR',items:MCR_ITEMS,lbl:'🖼 MCR'},{key:'gal_INTERCOM',items:INTERCOM_ITEMS,lbl:'🖼 Intercom'},
    {key:'gal_FFT',items:FFT_ITEMS,lbl:'🖼 FFT'},{key:'gal_RF_CAMS',items:RF_CAMS_ITEMS,lbl:'🖼 RF Cams'},
    {key:'gal_NOVA_105',items:NOVA_105_ITEMS,lbl:'🖼 Nova 105'},{key:'gal_EIC_AIC',items:EIC_AIC_ITEMS,lbl:'🖼 EIC/AIC'},
  ];
  for(const {key,items,lbl} of galMap){
    const sect=d[key]||{};
    items.forEach((name,i)=>{ const e=sect[i]; if(e?.checked&&e.ts) events.push({ts:e.ts,user:e.user||'—',label:name,section:lbl}); });
  }

  // Filter op vandaag
  const filtered = onlyToday
    ? events.filter(e => new Date(e.ts).toISOString().slice(0,10) === todayStr)
    : events;

  // Sorteer nieuwste eerst
  filtered.sort((a,b) => b.ts - a.ts);

  if(!filtered.length){
    wrap.innerHTML = `<div style="text-align:center;padding:40px 20px;color:#aaa;font-size:12px;letter-spacing:.06em">${onlyToday?'Nog niets afgevinkt vandaag':'Geen activiteit gevonden'}</div>`;
    return;
  }

  // Groepeer op uur
  const groups = {};
  filtered.forEach(e => {
    const d2 = new Date(e.ts);
    const hdr = d2.toLocaleDateString('nl-NL',{weekday:'short',day:'numeric',month:'short'}) + ' · ' + d2.getHours().toString().padStart(2,'0') + ':00';
    if(!groups[hdr]) groups[hdr] = [];
    groups[hdr].push(e);
  });

  const userColors = ['#C1440E','#2D5A1B','#4a3a7a','#0e4f6e','#7a5800','#8B2E07','#1e4d10'];
  const colorMap = {};
  let colorIdx = 0;

  wrap.innerHTML = Object.entries(groups).map(([hour, items]) => {
    const rows = items.map(e => {
      if(!colorMap[e.user]){ colorMap[e.user] = userColors[colorIdx++ % userColors.length]; }
      const col = colorMap[e.user];
      const time = new Date(e.ts).toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'});
      return `<div style="display:grid;grid-template-columns:42px 80px 1fr;gap:8px;align-items:start;padding:8px 12px;border-bottom:1px solid var(--border);">
        <span style="font-size:11px;color:#aaa;font-variant-numeric:tabular-nums;padding-top:1px">${time}</span>
        <span style="font-size:10px;font-weight:600;color:${col};background:${col}18;border-radius:4px;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(e.user)}</span>
        <span style="font-size:11px;"><span style="color:var(--ink);font-weight:500">${esc(e.label)}</span><br><span style="font-size:9px;color:#aaa;letter-spacing:.04em">${esc(e.section)}</span></span>
      </div>`;
    }).join('');
    return `<div style="margin-bottom:16px;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;overflow:hidden;">
      <div style="padding:8px 12px;background:var(--bg);border-bottom:1.5px solid var(--border);font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--clay-dark)">${hour}</div>
      ${rows}
    </div>`;
  }).join('');
}

function buildPersons(){
  const d = load();
  const wrap = document.getElementById("persons-list");
  if(!wrap) return;

  const persons = {};

  function addItem(user, section, label, ts){
    if(!user) user = "Onbekend";
    if(!persons[user]) persons[user] = [];
    persons[user].push({section, label, ts});
  }

  const courtMap = {c14:C14_CAMS,pc:PC_CAMS,sl:SL_CAMS,sm:SM_CAMS};
  const courtLabels = {c14:"C14",pc:"PC",sl:"SL",sm:"SM"};
  for(const [sk,cams] of Object.entries(courtMap)){
    cams.forEach(cam=>{
      getRows(sk,cam.num).forEach(row=>{
        const rd=(d[sk]||{})[`cam${cam.num}`]?.[row]||{};
        if(rd.checked) addItem(rd.user, courtLabels[sk]+" CAM "+cam.num, row, rd.ts);
      });
    });
  }

  const commMap={comm_pc4th:{pos:PC4TH_POSITIONS,lbl:"PC 4TH"},comm_pc5th:{pos:PC5TH_POSITIONS,lbl:"PC 5TH"},comm_sl:{pos:COMMSL_POSITIONS,lbl:"SL"},comm_sm:{pos:COMMSM_POSITIONS,lbl:"SM"}};
  for(const [sk,{pos,lbl}] of Object.entries(commMap)){
    pos.forEach(p=>{
      POS_CHECKS.forEach(chk=>{
        const pd=(d[sk]||{})[p]||{};
        if(pd[chk]) addItem(pd[chk+"_user"], lbl+" "+p, chk, pd[chk+"_ts"]);
      });
    });
  }

  CCSR_ITEMS.forEach((name,i)=>{
    const e=(d.gal_CCSR||{})[i]||{};
    if(e.checked) addItem(e.user, "CCSR", name, e.ts);
  });

  if(Object.keys(persons).length===0){
    wrap.innerHTML='<p style="color:#aaa;font-size:12px;padding:20px 0;text-align:center;">Nog geen afgevinkte items gevonden.</p>';
    return;
  }

  const sorted = Object.entries(persons).sort((a,b)=>b[1].length-a[1].length);
  const total = sorted.reduce((s,[,items])=>s+items.length,0);

  wrap.innerHTML = sorted.map(([name, items])=>{
    const pct = Math.round(items.length/total*100);
    const recentItems = [...items].sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,5);
    return `<div class="person-card">
      <div class="person-name">
        👤 ${esc(name)}
        <span class="person-count">${items.length} items · ${pct}%</span>
      </div>
      <div class="person-track"><div class="person-fill" style="width:${pct}%"></div></div>
      <div class="person-items">
        ${recentItems.map(it=>`<div class="person-item-row"><span>${esc(it.section)} — ${esc(it.label)}</span><span style="color:#bbb;margin-left:auto;font-size:10px">${fmtTime(it.ts)}</span></div>`).join('')}
        ${items.length>5?`<div style="color:#bbb;font-size:10px;padding-top:4px">+ ${items.length-5} meer items…</div>`:''}
      </div>
    </div>`;
  }).join('');
}

function buildProblems(){
  const d = load();
  const wrap = document.getElementById("problems-list");
  if(!wrap) return;
  const items = [];

  const courtMap = {c14:C14_CAMS, pc:PC_CAMS, sl:SL_CAMS, sm:SM_CAMS};
  const courtLabels = {c14:"C14",pc:"Philippe-Chatrier",sl:"Suzanne-Lenglen",sm:"Simonne-Mathieu"};
  for(const [sk,cams] of Object.entries(courtMap)){
    cams.forEach(cam=>{
      getRows(sk,cam.num).forEach(row=>{
        const rd = (d[sk]||{})[`cam${cam.num}`]?.[row]||{};
        if(!rd.checked || rd.note){
          items.push({
            section: courtLabels[sk]+" · CAM "+cam.num,
            label: row+(rd.checked?" ✓":""),
            note: rd.note||"",
            done: rd.checked||false,
            user: rd.user||"", ts: rd.ts||null
          });
        }
      });
    });
  }

  const commMap = {comm_pc4th:{pos:PC4TH_POSITIONS,lbl:"PC 4TH"}, comm_pc5th:{pos:PC5TH_POSITIONS,lbl:"PC 5TH"}, comm_sl:{pos:COMMSL_POSITIONS,lbl:"Comm SL"}, comm_sm:{pos:COMMSM_POSITIONS,lbl:"Comm SM"}};
  for(const [sk,{pos,lbl}] of Object.entries(commMap)){
    pos.forEach(p=>{
      POS_CHECKS.forEach(chk=>{
        const pd = (d[sk]||{})[p]||{};
        const note = pd[chk+"_note"]||"";
        if(!pd[chk] || note){
          items.push({ section:lbl+" · "+p, label:chk+(pd[chk]?" ✓":""), note, done:pd[chk]||false, user:pd[chk+"_user"]||"", ts:pd[chk+"_ts"]||null });
        }
      });
    });
  }

  const audioMap = [
    {key:'audio_pc',  list:PC_MIC_ITEMS,  lbl:'Audio PC · Microfoons'},
    {key:'audio_sl',  list:SL_MIC_ITEMS,  lbl:'Audio SL · Microfoons'},
    {key:'audio_sm',  list:SM_MIC_ITEMS,  lbl:'Audio SM · Microfoons'},
    {key:'audio_c14', list:C14_MIC_ITEMS, lbl:'Audio C14 · Microfoons'},
    {key:'sb_pc',     list:PC_SB_ITEMS,   lbl:'Audio PC · Stageboxes'},
    {key:'sb_sl',     list:SL_SB_ITEMS,   lbl:'Audio SL · Stageboxes'},
    {key:'sb_sm',     list:SM_SB_ITEMS,   lbl:'Audio SM · Stageboxes'},
    {key:'sb_c14',    list:C14_SB_ITEMS,  lbl:'Audio C14 · Stageboxes'},
  ];
  for(const {key, list, lbl} of audioMap){
    list.forEach((name, i)=>{
      const e = (d[key]||{})[i]||{};
      if(!e.checked || e.note){
        items.push({ section:lbl, label:name+(e.checked?' ✓':''), note:e.note||'', done:e.checked||false, user:e.user||'', ts:e.ts||null });
      }
    });
  }

  if(d.gal_CCSR){
    CCSR_ITEMS.forEach((name,i)=>{
      const e = d.gal_CCSR[i]||{};
      if(!e.checked || e.note){
        items.push({ section:"CCSR", label:name+(e.checked?" ✓":""), note:e.note||"", done:e.checked||false, user:e.user||"", ts:e.ts||null });
      }
    });
  }

  document.getElementById("problems-count").textContent = items.filter(i=>!i.done).length+" open";

  if(items.length===0){
    wrap.innerHTML='<p style="color:#aaa;font-size:12px;padding:20px 0;text-align:center;">Geen openstaande items 🎾</p>';
    return;
  }

  wrap.innerHTML = items.map(item=>`
    <div class="problem-item${item.note?' has-note':''}">
      <div class="problem-section">${esc(item.section)}</div>
      <div class="problem-label">${esc(item.label)}${item.done?'':' <span style="color:var(--clay);font-size:10px">● Open</span>'}</div>
      ${item.note?`<div class="problem-note">📝 ${esc(item.note)}</div>`:''}
      ${item.user||item.ts?`<div class="problem-note" style="color:#bbb">👤 ${esc(item.user||'—')} · ${fmtTime(item.ts)}</div>`:''}
    </div>`).join('');
}

function exportExcel(){
  if(window._loadXLSX){ window._loadXLSX(_doExportExcel); return; } _doExportExcel();
}
function _doExportExcel(){
  if(typeof XLSX === "undefined"){ alert("Excel library niet geladen. Controleer je internetverbinding."); return; }
  const d = load();
  const wb = XLSX.utils.book_new();
  const now = new Date().toLocaleDateString("nl-NL");

  function fmtStatus(checked){ return checked ? "✓" : "—"; }
  function fmtUser(user){ return user||""; }
  function fmtTs(ts){ return ts ? new Date(ts).toLocaleString("nl-NL",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : ""; }

  const courtMap = {c14:{cams:C14_CAMS,label:"C14"}, pc:{cams:PC_CAMS,label:"Philippe-Chatrier"}, sl:{cams:SL_CAMS,label:"Suzanne-Lenglen"}, sm:{cams:SM_CAMS,label:"Simonne-Mathieu"}};

  for(const [sk, {cams, label}] of Object.entries(courtMap)){
    const rows = [["CAM", "Naam/Positie", "Rij", "Status", "Door", "Tijdstip", "Notitie"]];
    cams.forEach(cam=>{
      const camKey = `cam${cam.num}`;
      const cd = (d[sk]||{})[camKey]||{};
      getRows(sk, cam.num).forEach(row=>{
        const rd = cd[row]||{};
        rows.push([
          `CAM ${cam.num}`,
          cam.name||cam.pos||"",
          row,
          fmtStatus(rd.checked),
          fmtUser(rd.user),
          fmtTs(rd.ts),
          rd.note||""
        ]);
      });
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);

    ws["!cols"] = [{wch:8},{wch:28},{wch:12},{wch:8},{wch:14},{wch:16},{wch:35}];

    XLSX.utils.book_append_sheet(wb, ws, label.substring(0,31));
  }

  const commRows = [["Box","Positie","Check","Status","Door","Tijdstip","Notitie"]];
  const commMap = {comm_pc4th:{pos:PC4TH_POSITIONS,lbl:"PC 4TH"}, comm_pc5th:{pos:PC5TH_POSITIONS,lbl:"PC 5TH"}, comm_sl:{pos:COMMSL_POSITIONS,lbl:"SL"}, comm_sm:{pos:COMMSM_POSITIONS,lbl:"SM"}};
  for(const [sk,{pos,lbl}] of Object.entries(commMap)){
    pos.forEach(p=>{
      const pd = (d[sk]||{})[p]||{};
      POS_CHECKS.forEach(chk=>{
        commRows.push([
          lbl, p, chk,
          fmtStatus(pd[chk]),
          fmtUser(pd[chk+"_user"]),
          fmtTs(pd[chk+"_ts"]),
          pd[chk+"_note"]||""
        ]);
      });
    });
  }
  const wsComm = XLSX.utils.aoa_to_sheet(commRows);
  wsComm["!cols"] = [{wch:10},{wch:10},{wch:12},{wch:8},{wch:14},{wch:16},{wch:35}];
  XLSX.utils.book_append_sheet(wb, wsComm, "Commentaar");

  const galRows = [["Gallery","Item","Status","Door","Tijdstip","Notitie"]];
  CCSR_ITEMS.forEach((name,i)=>{
    const e = (d.gal_CCSR||{})[i]||{};
    galRows.push(["CCSR", name, fmtStatus(e.checked), fmtUser(e.user), fmtTs(e.ts), e.note||""]);
  });
  const wsGal = XLSX.utils.aoa_to_sheet(galRows);
  wsGal["!cols"] = [{wch:14},{wch:20},{wch:8},{wch:14},{wch:16},{wch:35}];
  XLSX.utils.book_append_sheet(wb, wsGal, "Gallery's");

  const filename = `RolandGarros_Status_${now.replace(/\//g,"-")}.xlsx`;
  XLSX.writeFile(wb, filename);
}

function resetStep1(){
  document.getElementById('reset-confirm').style.display = 'block';
  document.getElementById('reset-btn-1').style.display = 'none';
}
function resetCancel(){
  document.getElementById('reset-confirm').style.display = 'none';
  document.getElementById('reset-btn-1').style.display = 'block';
}
function resetConfirm(){
  const d = load();
  const keep = { loggedIn: d.loggedIn, _users: d._users, _overdrachten: d._overdrachten, _resetTs: Date.now() };
  localStorage.setItem(SK, JSON.stringify(keep));
  if(window.pushToSupabase) window.pushToSupabase(keep);
  buildAllLists();
  refreshAll();
  resetCancel();
  if(navigator.vibrate) navigator.vibrate([30,50,30]);
}

let _adminResetKeys = [];
function adminResetCourt(keys, label){
  _adminResetKeys = keys;
  document.getElementById('admin-reset-label').textContent = label;
  document.getElementById('admin-reset-confirm').style.display = 'block';
}
function adminResetCancel(){
  _adminResetKeys = [];
  document.getElementById('admin-reset-confirm').style.display = 'none';
}
function adminResetConfirm(){
  const d = load();
  const resetTs = Date.now();
  if(!d._courtResets) d._courtResets = {};
  _adminResetKeys.forEach(k => { delete d[k]; d._courtResets[k] = resetTs; });
  _localSaveRaw(d);
  if(window.pushToSupabase) window.pushToSupabase(d);
  buildAllLists();
  refreshAll();
  adminResetCancel();
  if(navigator.vibrate) navigator.vibrate([30,50,30]);
}

function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('img').forEach(img => {
    img.style.cursor = 'pointer';
    img.onclick = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (img.requestFullscreen) {
        img.requestFullscreen();
      }
    };
  });
});

(function init(){

  // Offline-banner bij opstarten
  if(!navigator.onLine){
    let banner = document.getElementById("offline-banner");
    if(!banner){
      banner = document.createElement("div");
      banner.id = "offline-banner";
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#C1440E;color:#fff;text-align:center;padding:10px 16px;font-size:13px;z-index:10000;";
      banner.textContent = "Geen internetverbinding — de app werkt offline maar synchroniseert niet.";
      document.body.appendChild(banner);
    }
  }
  window.addEventListener("online",  ()=>{ document.getElementById("offline-banner")?.remove(); });
  window.addEventListener("offline", ()=>{
    if(!document.getElementById("offline-banner")){
      const b = document.createElement("div");
      b.id = "offline-banner";
      b.style.cssText = "position:fixed;top:0;left:0;right:0;background:#C1440E;color:#fff;text-align:center;padding:10px 16px;font-size:13px;z-index:10000;";
      b.textContent = "Geen internetverbinding — de app werkt offline maar synchroniseert niet.";
      document.body.appendChild(b);
    }
  });

  const savedTheme = localStorage.getItem("rg_theme")||"light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  const dtBtn = document.querySelector(".dark-toggle");
  if(dtBtn) dtBtn.textContent = savedTheme==="dark" ? "☀️" : "🌙";

  const remembered = getCurrentUser();
  const nameInp = document.getElementById("login-name");
  if(nameInp && remembered){

    Array.from(nameInp.options).forEach(o=>{ if(o.value===remembered) o.selected=true; });
  }

  const saved = getCurrentUser();
  const userLbl = document.getElementById("logged-in-user");
  if(userLbl && saved) userLbl.textContent = "👤 " + saved;
  updateLastUpdateLabel();

  try{

    if(window.initSupabase) setTimeout(()=>window.initSupabase(), 600);
  }catch(e){}
  buildGallery();
  buildSimpleList("list-gal-CCSR","gal_CCSR",CCSR_ITEMS);

  rebuildNameDropdown();

  const remembered2 = getCurrentUser();
  if(remembered2){
    const sel = document.getElementById("login-name");
    if(sel) Array.from(sel.options).forEach(o=>{ if(o.value===remembered2) o.selected=true; });
  }
  buildCamPage("list-c14","c14",C14_CAMS);
  buildCamPage("list-pc","pc",PC_CAMS);
  buildCamPage("list-sl","sl",SL_CAMS);
  buildCamPage("list-sm","sm",SM_CAMS);
  buildPosList("list-comm-pc5th","comm_pc5th",PC5TH_POSITIONS);
  buildPosList("list-comm-sl","comm_sl",COMMSL_POSITIONS);
  buildPosList("list-comm-sm","comm_sm",COMMSM_POSITIONS);
  buildPosList("list-comm-pc4th","comm_pc4th",PC4TH_POSITIONS);
  restoreChecks("courts");
  restoreChecks("comm");
  refreshAll();
})();


function openLightbox(img){
  const lb = document.getElementById("lightbox");
  const lbImg = document.getElementById("lightbox-img");
  lbImg.src = "";
  setTimeout(()=>{ lbImg.src = img.src; }, 10);
  lb.style.cssText = "display:flex;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;flex-direction:column;align-items:center;justify-content:center;cursor:zoom-out;";
  document.body.style.overflow = "hidden";
  if(navigator.vibrate) navigator.vibrate(15);
}
function closeLightbox(){
  const lb = document.getElementById("lightbox");
  lb.style.display = "none";
  document.getElementById("lightbox-img").src = "";
  document.body.style.overflow = "";
}
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeLightbox(); });

function buildOverdracht(){
  // Set default date to today
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById('od-date');
  if(dateEl && !dateEl.value) dateEl.value = today;

  // Set logged-in user in dropdown
  const nameEl = document.getElementById('od-name');
  if(nameEl){
    const users = getUsers();
    const cur = getCurrentUser();
    nameEl.innerHTML = users.map(u=>`<option${u===cur?' selected':''}>${esc(u)}</option>`).join('');
  }

  // Restore concept from localStorage
  const concept = JSON.parse(localStorage.getItem('rg_od_concept')||'{}');
  const verslagEl = document.getElementById('od-verslag');
  const todoEl    = document.getElementById('od-todo');
  if(verslagEl && concept.verslag) verslagEl.value = concept.verslag;
  if(todoEl    && concept.todo)    todoEl.value    = concept.todo;
  if(dateEl    && concept.date)    dateEl.value    = concept.date;
  const shiftEl = document.getElementById('od-shift');
  if(shiftEl && concept.shift) shiftEl.value = concept.shift;

  // Auto-save concept on input
  const saveConcept = () => {
    localStorage.setItem('rg_od_concept', JSON.stringify({
      verslag: verslagEl?.value || '',
      todo:    todoEl?.value    || '',
      date:    dateEl?.value    || '',
      shift:   shiftEl?.value   || '',
    }));
  };
  verslagEl?.addEventListener('input', saveConcept);
  todoEl   ?.addEventListener('input', saveConcept);
  dateEl   ?.addEventListener('change', saveConcept);
  shiftEl  ?.addEventListener('change', saveConcept);

  renderOdLog();
}

function saveOverdracht(){
  const name    = document.getElementById('od-name')?.value;
  const date    = document.getElementById('od-date')?.value;
  const shift   = document.getElementById('od-shift')?.value;
  const verslag = document.getElementById('od-verslag')?.value.trim();
  const todo    = document.getElementById('od-todo')?.value.trim();
  if(!verslag && !todo){ showOdToast('Vul minimaal één veld in', 'error'); return; }
  if(!date){ showOdToast('Vul een datum in', 'error'); return; }
  if(!shift){ showOdToast('Kies een shift (Ochtend of Avond)', 'error'); return; }

  const d = load();
  if(!d._overdrachten) d._overdrachten = [];
  d._overdrachten.push({ id: Date.now(), name, date, shift, verslag, todo, ts: Date.now(), user: getCurrentUser() });
  save(d);
  if(window.pushToSupabase) window.pushToSupabase(d);

  // Clear form + concept
  document.getElementById('od-verslag').value = '';
  document.getElementById('od-todo').value = '';
  odWordCount('od-verslag','od-verslag-wc');
  odWordCount('od-todo','od-todo-wc');
  localStorage.removeItem('rg_od_concept');

  if(navigator.vibrate) navigator.vibrate([20, 30, 20]);
  showOdToast('✅ Overdracht opgeslagen!', 'success');
  renderOdLog();

  // Scroll to log
  setTimeout(()=>{
    document.getElementById('od-log')?.scrollIntoView({behavior:'smooth', block:'start'});
  }, 300);
}

function showOdToast(msg, type='success'){
  let t = document.getElementById('od-toast');
  if(!t){
    t = document.createElement('div');
    t.id = 'od-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'od-toast od-toast-' + type;
  t.style.opacity = '1';
  t.style.transform = 'translateY(0)';
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>{
    t.style.opacity = '0';
    t.style.transform = 'translateY(10px)';
  }, 2500);
}

function getOdLastRead(){
  const user = getCurrentUser();
  if(!user) return 0;
  return parseInt(localStorage.getItem('rg_od_lastread_'+user)||'0');
}
function setOdLastRead(){
  const user = getCurrentUser();
  if(!user) return;
  localStorage.setItem('rg_od_lastread_'+user, Date.now().toString());
}
function countUnreadOd(){
  const d = load();
  const lastRead = getOdLastRead();
  const me = getCurrentUser();
  return (d._overdrachten||[]).filter(e=>!e.deleted && (e.ts||0)>lastRead && e.user!==me).length;
}

window.renderOdLog = function renderOdLog(){
  const wrap = document.getElementById('od-log');
  if(!wrap) return;
  const d = load();
  const entries = (d._overdrachten || []).filter(e=>!e.deleted).slice().reverse();

  // Update home card
  const homeSub = document.getElementById('od-home-sub');
  const homeCount = document.getElementById('od-home-count');
  const homeBar = document.getElementById('od-home-bar');
  if(homeSub) homeSub.textContent = entries.length ? entries.length + ' overdracht' + (entries.length!==1?'en':'') + ' opgeslagen' : 'Bekijk en schrijf overdrachten';
  if(homeCount) homeCount.textContent = entries.length ? entries.length+'x' : '';
  if(homeBar) homeBar.style.width = entries.length ? Math.min(100, entries.length * 10) + '%' : '0%';
  const badgeEl = document.getElementById('od-badge');
  if(badgeEl){ const u=countUnreadOd(); badgeEl.textContent=u||''; badgeEl.hidden=u===0; }

  if(!entries.length){
    wrap.innerHTML = '<div class="od-empty">Nog geen overdrachten</div>';
    return;
  }

  const groups = {};
  entries.forEach(e => {
    if(!groups[e.date]) groups[e.date] = [];
    groups[e.date].push(e);
  });

  const OD_COLORS = [
    {bg:'rgba(193,68,14,.12)',border:'rgba(193,68,14,.35)',text:'#7a2e06'},
    {bg:'rgba(45,90,27,.12)', border:'rgba(45,90,27,.35)', text:'#1e4d10'},
    {bg:'rgba(100,80,160,.12)',border:'rgba(100,80,160,.35)',text:'#4a3a7a'},
    {bg:'rgba(20,100,140,.12)',border:'rgba(20,100,140,.35)',text:'#0e4f6e'},
    {bg:'rgba(180,130,20,.12)',border:'rgba(180,130,20,.35)',text:'#7a5800'},
  ];
  const today = new Date().toISOString().split('T')[0];
  const sortedDates = Object.keys(groups).sort((a,b)=>b.localeCompare(a));
  wrap.innerHTML = sortedDates.map((date, idx) => {
    const items = groups[date];
    const isToday = date === today;
    const gid = 'odg-' + date;
    const d2 = new Date(date + 'T12:00:00');
    const dateLabel = d2.toLocaleDateString('nl-NL',{weekday:'long',day:'numeric',month:'long'});
    const col = OD_COLORS[idx % OD_COLORS.length];

    const itemsHtml = items.map(e => `
      <div class="od-item">
        <div class="od-item-header">
          <div class="od-item-name">
            <span class="od-shift-badge od-shift-${e.shift||'ochtend'}">${e.shift==='avond'?'🌙':'🌅'} ${e.shift||'ochtend'}</span>
            ${esc(e.name||'')}
          </div>
        </div>
        <div class="od-sections-grid">
          ${e.verslag?`<div class="od-section"><div class="od-section-label">📋 Dagverslag</div><div class="od-section-text">${esc(e.verslag)}</div></div>`:''}
          ${e.todo?`<div class="od-section"><div class="od-section-label">📌 To do volgende ploeg</div><div class="od-section-text">${esc(e.todo)}</div></div>`:''}
        </div>
        ${(e.user||e.name)===getCurrentUser() ? `
        <div class="od-item-actions">
          <button class="od-action-btn" onclick="openOdEdit(${e.id})" style="touch-action:manipulation;">✏️ Aanpassen</button>
          <button class="od-action-btn delete" onclick="deleteOverdracht(${e.id})" style="touch-action:manipulation;">🗑 Verwijderen</button>
        </div>` : ''}
      </div>`).join('');

    return `<div class="section" style="padding:0;background:none;border:none;box-shadow:none;margin-bottom:8px;">
      <div class="od-day-header" onclick="odToggle('${gid}')" style="background:${col.bg};border-color:${col.border};color:${col.text}">
        <span class="od-day-label">${dateLabel}${isToday?' <span class="od-today">vandaag</span>':''}</span>
        <span class="od-day-count">${items.length} overdracht${items.length>1?'en':''}</span>
        <span class="od-day-chev" id="chev-${gid}">▾</span>
      </div>
      <div id="${gid}">${itemsHtml}</div>
    </div>`;
  }).join('');
}

function odToggle(id){
  const el = document.getElementById(id);
  const chev = document.getElementById('chev-'+id);
  if(!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  if(chev) chev.textContent = open ? '▸' : '▾';
}

let _odEditId = null;

function openOdEdit(id){
  const d = load();
  const entry = (d._overdrachten||[]).find(e=>e.id===id);
  if(!entry) return;
  _odEditId = id;
  document.getElementById('od-edit-verslag').value = entry.verslag || '';
  document.getElementById('od-edit-todo').value = entry.todo || '';
  odWordCount('od-edit-verslag','od-edit-verslag-wc');
  odWordCount('od-edit-todo','od-edit-todo-wc');
  const modal = document.getElementById('od-edit-modal');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  if(navigator.vibrate) navigator.vibrate(15);
}

function closeOdEdit(){
  document.getElementById('od-edit-modal').style.display = 'none';
  document.body.style.overflow = '';
  _odEditId = null;
}

function confirmOdEdit(){
  if(!_odEditId) return;
  const d = load();
  const arr = d._overdrachten || [];
  const idx = arr.findIndex(e=>e.id===_odEditId);
  if(idx === -1) return;
  arr[idx].verslag = document.getElementById('od-edit-verslag').value.trim();
  arr[idx].todo    = document.getElementById('od-edit-todo').value.trim();
  arr[idx].editedTs = Date.now();
  d._overdrachten = arr;
  save(d);
  if(window.pushToSupabase) window.pushToSupabase(d);
  closeOdEdit();
  renderOdLog();
  if(navigator.vibrate) navigator.vibrate(20);
}

function deleteOverdracht(id){
  // Use custom confirm — native confirm() blocked in some PWA/iframe contexts
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)';
  overlay.innerHTML = `<div style="background:var(--surface);border-radius:14px;padding:24px;width:calc(100% - 48px);max-width:320px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)">
    <div style="font-size:28px;margin-bottom:10px">🗑️</div>
    <div style="font-family:'Playfair Display',serif;font-size:16px;font-weight:700;color:var(--ink);margin-bottom:8px">Verwijderen?</div>
    <div style="font-size:11px;color:#aaa;margin-bottom:20px;letter-spacing:.04em">Deze overdracht wordt permanent verwijderd</div>
    <div style="display:flex;gap:8px">
      <button id="od-del-cancel" style="flex:1;padding:11px;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;font-family:'DM Mono',monospace;font-size:11px;cursor:pointer;touch-action:manipulation">Annuleer</button>
      <button id="od-del-confirm" style="flex:1;padding:11px;background:#c0392b;color:white;border:none;border-radius:8px;font-family:'DM Mono',monospace;font-size:11px;cursor:pointer;touch-action:manipulation">Verwijderen</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('od-del-cancel').onclick = () => document.body.removeChild(overlay);
  document.getElementById('od-del-confirm').onclick = () => {
    document.body.removeChild(overlay);
    const d = load();
    const entry = (d._overdrachten||[]).find(e=>e.id===id);
    if(entry){ entry.deleted = true; entry.editedTs = Date.now(); }
    save(d);
    if(window.pushToSupabase) window.pushToSupabase(d);
    renderOdLog();
    if(navigator.vibrate) navigator.vibrate(30);
  };
}

// ── USER MANAGEMENT ──────────────────────────────────────────────
function getUsers(){
  try {
    const d = load();
    if(d._users && d._users.length) return [...d._users].sort((a,b)=>a.localeCompare(b,'nl'));
    const stored = localStorage.getItem('rg_users');
    const list = stored ? JSON.parse(stored) : DEFAULT_USERS;
    return [...list].sort((a,b)=>a.localeCompare(b,'nl'));
  } catch { return [...DEFAULT_USERS].sort((a,b)=>a.localeCompare(b,'nl')); }
}

function saveUsers(users){
  const sorted = [...users].sort((a,b)=>a.localeCompare(b,'nl'));
  localStorage.setItem('rg_users', JSON.stringify(sorted));
  const d = load();
  d._users = sorted;
  d._usersTs = Date.now();  // timestamp so remote can't silently overwrite
  d._lastUpdate = Date.now();
  localStorage.setItem(SK, JSON.stringify(d));
  rebuildNameDropdown();
  if(window.pushToSupabase) window.pushToSupabase(d);
}

function addUser(){
  const input = document.getElementById('new-user-input');
  if(!input) return;
  const name = input.value.trim();
  if(!name) return;
  const users = getUsers();
  if(users.map(u=>u.toLowerCase()).includes(name.toLowerCase())){
    input.value = '';
    input.placeholder = 'Naam bestaat al…';
    setTimeout(()=>{ input.placeholder = 'Nieuwe naam toevoegen…'; }, 2000);
    return;
  }
  saveUsers([...users, name]);
  input.value = '';
  buildUsers();
  if(navigator.vibrate) navigator.vibrate(20);
}

function removeUser(name){
  const wrap = document.getElementById('users-list');
  // Find the row and show inline confirm
  const rows = wrap.querySelectorAll('.user-row');
  rows.forEach(row => {
    if(row.dataset.name === name){
      if(row.querySelector('.user-row-confirm')) return; // already showing
      const conf = document.createElement('div');
      conf.className = 'user-row-confirm';
      conf.innerHTML = `<span style="font-size:11px;color:var(--clay);">Verwijderen?</span>
        <button onclick="doRemoveUser('${esc(name)}')" style="background:var(--clay-dark);color:var(--cream);border:none;font-family:'DM Mono',monospace;font-size:10px;padding:5px 12px;border-radius:5px;cursor:pointer;touch-action:manipulation;">Ja</button>
        <button onclick="this.closest('.user-row-confirm').remove();row.querySelector('.user-row-del').style.display='flex';" style="background:none;border:1px solid var(--border);color:var(--ink);font-family:'DM Mono',monospace;font-size:10px;padding:5px 10px;border-radius:5px;cursor:pointer;touch-action:manipulation;">Nee</button>`;
      row.querySelector('.user-row-del').style.display = 'none';
      row.appendChild(conf);
    }
  });
}
function doRemoveUser(name){
  saveUsers(getUsers().filter(u=>u!==name));
  buildUsers();
  if(navigator.vibrate) navigator.vibrate(30);
}

function buildUsers(){
  const wrap = document.getElementById('users-list');
  if(!wrap) return;
  const users = getUsers();
  if(!users.length){
    wrap.innerHTML = '<div class="users-empty">Geen gebruikers</div>';
    return;
  }
  wrap.innerHTML = users.map(name=>`
    <div class="user-row" data-name="${esc(name)}">
      <span class="user-row-name">👤 ${esc(name)}</span>
      <button class="user-row-del" onclick="removeUser('${esc(name)}')" ontouchend="event.preventDefault();removeUser('${esc(name)}');" style="touch-action:manipulation;">✕</button>
    </div>`).join('');
}

function rebuildNameDropdown(){
  const users = getUsers();
  const cur = getCurrentUser();
  ['login-name', 'od-name'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    const placeholder = cur ? '' : `<option value="" disabled selected>— Kies je naam —</option>`;
    el.innerHTML = placeholder + users.map(u=>`<option${u===cur?' selected':''}>${esc(u)}</option>`).join('');
  });
}



// ── USER MANAGEMENT END ─────────────────────────────────────────


// ── BACKUP ───────────────────────────────────────────────────────
function backupToJSON(){
  closeAdminModal();
  const d = load();
  const date = new Date().toISOString().split('T')[0];
  const filename = 'rg2026-backup-' + date + '.json';
  const blob = new Blob([JSON.stringify(d, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  if(navigator.vibrate) navigator.vibrate(20);
}

// ── AUDIO ────────────────────────────────────────────────────────
function switchCourtTab(tab){
  document.getElementById('courts-tab-camera').style.display = tab==='camera' ? '' : 'none';
  document.getElementById('courts-tab-audio').style.display  = tab==='audio'  ? '' : 'none';
}

function buildAudioLists(){
  const allLists = [
    {key:'sb_pc',     items:PC_SB_ITEMS,   listId:'list-sb-pc'},
    {key:'sb_sl',     items:SL_SB_ITEMS,   listId:'list-sb-sl'},
    {key:'sb_sm',     items:SM_SB_ITEMS,   listId:'list-sb-sm'},
    {key:'sb_c14',    items:C14_SB_ITEMS,  listId:'list-sb-c14'},
    {key:'audio_pc',  items:PC_MIC_ITEMS,  listId:'list-audio-pc'},
    {key:'audio_sl',  items:SL_MIC_ITEMS,  listId:'list-audio-sl'},
    {key:'audio_sm',  items:SM_MIC_ITEMS,  listId:'list-audio-sm'},
    {key:'audio_c14', items:C14_MIC_ITEMS, listId:'list-audio-c14'},
  ];
  allLists.forEach(({key, items, listId}) => {
    const container = document.getElementById(listId);
    if(!container) return;
    const d = load();
    if(!d[key]) d[key] = {};
    container.innerHTML = items.map((name, i) => {
      const ed = d[key][i] || {};
      const isDone = ed.checked || false;
      const note = ed.note || '';
      const meta = ed.ts ? `<span class="row-meta">${esc(ed.user||'')}${ed.user?' · ':''}${fmtTime(ed.ts)}</span>` : '';
      return `<div class="simple-row${isDone?' row-done':''}" id="${listId}-srow-${i}">
        <div class="simple-check${isDone?' on':''}" onclick="audioToggle('${key}',${i},'${listId}')"><span class="ck">✓</span></div>
        <div class="simple-label-wrap" onclick="audioToggle('${key}',${i},'${listId}')">
          <span class="simple-item-label">${esc(name)}${meta}</span>
          ${note?`<span class="cam-note-pill">📝 ${esc(note.length>50?note.slice(0,50)+'…':note)}</span>`:''}
        </div>
        <textarea class="simple-note" placeholder="Notitie…" oninput="audioNote('${key}',${i},this)">${esc(note)}</textarea>
      </div>`;
    }).join('');
  });
  refreshAudioCounters();
}

function audioToggle(key, i, listId){
  const d = load();
  if(!d[key]) d[key] = {};
  if(!d[key][i]) d[key][i] = {};
  d[key][i].checked = !d[key][i].checked;
  if(d[key][i].checked){ d[key][i].ts = Date.now(); d[key][i].user = getCurrentUser(); }
  else { d[key][i].ts = null; d[key][i].user = null; }
  save(d);
  if(window.pushToSupabase) window.pushToSupabase(d);
  const row = document.getElementById(listId+'-srow-'+i);
  if(row){
    row.classList.toggle('row-done', d[key][i].checked);
    row.querySelector('.simple-check').classList.toggle('on', d[key][i].checked);
    const metaEl = row.querySelector('.row-meta');
    const labelEl = row.querySelector('.simple-item-label');
    if(metaEl) metaEl.remove();
    if(d[key][i].checked && labelEl){
      const meta = document.createElement('span');
      meta.className = 'row-meta';
      meta.textContent = (d[key][i].user||'') + (d[key][i].user?' · ':'') + fmtTime(d[key][i].ts);
      labelEl.appendChild(meta);
    }
  }
  if(navigator.vibrate) navigator.vibrate(d[key][i].checked ? 30 : 15);
  refreshAudioCounters();
}

function audioNote(key, i, el){
  const d = load();
  if(!d[key]) d[key] = {};
  if(!d[key][i]) d[key][i] = {};
  d[key][i].note = el.value;
  save(d);
  if(window.pushToSupabase) window.pushToSupabase(d);
}

function refreshAudioCounters(){
  const courts = [
    {micKey:'audio_pc',  sbKey:'sb_pc',  micItems:PC_MIC_ITEMS,  sbItems:PC_SB_ITEMS,  barId:'audio-pc-bar',  lblId:'audio-pc-lbl',  countId:'count-audio-pc',  sbCountId:'count-sb-pc',  noteId:'audio-pc-note-label',  chipId:'chip-audio-pc'},
    {micKey:'audio_sl',  sbKey:'sb_sl',  micItems:SL_MIC_ITEMS,  sbItems:SL_SB_ITEMS,  barId:'audio-sl-bar',  lblId:'audio-sl-lbl',  countId:'count-audio-sl',  sbCountId:'count-sb-sl',  noteId:'audio-sl-note-label',  chipId:'chip-audio-sl'},
    {micKey:'audio_sm',  sbKey:'sb_sm',  micItems:SM_MIC_ITEMS,  sbItems:SM_SB_ITEMS,  barId:'audio-sm-bar',  lblId:'audio-sm-lbl',  countId:'count-audio-sm',  sbCountId:'count-sb-sm',  noteId:'audio-sm-note-label',  chipId:'chip-audio-sm'},
    {micKey:'audio_c14', sbKey:'sb_c14', micItems:C14_MIC_ITEMS, sbItems:C14_SB_ITEMS, barId:'audio-c14-bar', lblId:'audio-c14-lbl', countId:'count-audio-c14', sbCountId:'count-sb-c14', noteId:'audio-c14-note-label', chipId:'chip-audio-c14'},
  ];
  const d = load();
  let grandTotal=0, grandDone=0;
  courts.forEach(({micKey,sbKey,micItems,sbItems,barId,lblId,countId,sbCountId,noteId,chipId}) => {
    const mcd = d[micKey]||{};
    const scd = d[sbKey]||{};
    const micDone  = micItems.filter((_,i) => mcd[i]?.checked).length;
    const sbDone   = sbItems.filter((_,i)  => scd[i]?.checked).length;
    const done  = micDone + sbDone;
    const total = micItems.length + sbItems.length;
    grandTotal += total; grandDone += done;
    const p = total ? Math.round(done/total*100) : 0;
    const barEl   = document.getElementById(barId);
    const lbl     = document.getElementById(lblId);
    const count   = document.getElementById(countId);
    const sbCount = document.getElementById(sbCountId);
    const noteEl  = document.getElementById(noteId);
    const chip    = document.getElementById(chipId);
    if(barEl)   barEl.style.width = p+'%';
    if(lbl)     lbl.textContent = done+'/'+total;
    if(count)   count.textContent = micDone+'/'+micItems.length;
    if(sbCount) sbCount.textContent = sbDone+'/'+sbItems.length;
    if(noteEl)  noteEl.textContent = done+' van '+total+' voltooid';
    if(chip)    chip.textContent = done+'/'+total;
    const doneMsg = document.getElementById(barId.replace('-bar','-done-msg'));
    if(doneMsg) done===total&&total>0 ? doneMsg.classList.add('visible') : doneMsg.classList.remove('visible');
  });
  const ac = document.getElementById('audio-courts-count');
  if(ac) ac.textContent = grandDone+'/'+grandTotal;
  txt('tab-audio-count', grandDone+'/'+grandTotal);
  txt('sel-audio-count', grandDone+'/'+grandTotal+' voltooid'); bar('sel-audio-bar', pct(grandDone,grandTotal));
}

// ── Overdracht word counter ──────────────────────────────────────
function odWordCount(taId, countId){
  const ta = document.getElementById(taId);
  const el = document.getElementById(countId);
  if(!ta || !el) return;
  const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
  el.textContent = words + ' woord' + (words === 1 ? '' : 'en');
}
// Reset counters when overdracht form opens
window._resetOdWordCounts = function(){
  ['od-verslag','od-todo','od-edit-verslag','od-edit-todo'].forEach(id=>{
    const wc = document.getElementById(id+'-wc');
    if(wc) wc.textContent = '0 woorden';
  });
};

// ── Auto-resize textareas ────────────────────────────────────────
function resizeTextarea(el){
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
document.addEventListener('input', e=>{
  if(e.target.tagName === 'TEXTAREA') resizeTextarea(e.target);
});

// ── Android hardware back button via History API ─────────────────
window.addEventListener('popstate', e => {
  const page = e.state?.page;
  if(!page) return;
  _handlingPop = true;
  goTo(page);
  _handlingPop = false;
});

// ── Swipe to go back (left-edge swipe → back button) ─────────────
(function(){
  let startX = 0, startY = 0, tracking = false;
  document.addEventListener('touchstart', e => {
    if(e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = startX < 30;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if(!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = Math.abs(e.changedTouches[0].clientY - startY);
    if(dx > 80 && dy < 60){
      const activePage = document.querySelector('.page.active');
      const backBtn = activePage && activePage.querySelector('.back-btn');
      if(backBtn) backBtn.click();
    }
  }, { passive: true });
})();
