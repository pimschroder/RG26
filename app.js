
(function(){
  let supaClient = null;
  let broadcastChannel = null;
  let pushDebounceTimer = null;
  let suppressRemote = false;
  const SUPABASE_URL = window._SUPABASE_URL || "https://owjccmlgfhbusncvmbac.supabase.co";
  const SUPABASE_KEY = window._SUPABASE_KEY || "sb_publishable_m5WPUe6APhOqHUQZOpj0-g_XZxzTVB5";

  function setSyncStatus(s){
    const el = document.getElementById("sync-status");
    if(!el) return;
    const pending = !!localStorage.getItem('rg_pending_sync');
    const map = {
      connected: ["live",    "Live"],
      synced:    [pending ? "saving" : "live",  pending ? "Niet gesynchroniseerd" : "Gesynchroniseerd"],
      offline:   ["offline", pending ? "Offline · wacht" : "Offline"],
      error:     ["error",   "Sync fout"],
      saving:    ["saving",  "Opslaan…"],
      receiving: ["saving",  "Ontvangen…"]
    };
    const [cls, txt] = map[s] || ["offline", "—"];
    el.className = cls;
    el.textContent = txt;
    el.style.cursor = s === 'error' ? 'pointer' : '';
    el.onclick = s === 'error' ? () => window._retrySync && window._retrySync() : null;
  }

  window.initSupabase = async function initSupabase(url, key){
    try{
      supaClient = supabase.createClient(url || SUPABASE_URL, key || SUPABASE_KEY);
      window._supaClient = supaClient;

      // Verify the Supabase session is real — blocks console localStorage bypass.
      // getSession() reads the cached JWT without needing network, so works offline too.
      try{
        const { data } = await supaClient.auth.getSession();
        if(!data?.session){
          // No valid session → clear loggedIn flag and force login screen
          const _load  = window._localLoad  || (()=>{ try{ return JSON.parse(localStorage.getItem('rg2026_v1'))||{}; }catch{ return {}; } });
          const _save  = window._localSaveRaw || ((d)=>{ try{ localStorage.setItem('rg2026_v1',JSON.stringify(d)); }catch{} });
          const d = _load();
          if(d.loggedIn){
            delete d.loggedIn;
            _save(d);
            document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
            const lp = document.getElementById('page-login');
            if(lp) lp.classList.add('active');
            try{ sessionStorage.removeItem('rg_admin'); }catch{}
          }
        }
      }catch(e){}

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
        // Prefer newer timestamp; on tie prefer local so deleted users can't come back
        merged[key] = remTs > locTs ? remUsers : locUsers;
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
    // Conflict detection: remote overwrote something the current user changed <60s ago
    if(flashSet.size > 0) detectConflicts(flashSet, local, merged);
    // Herbouw alleen de actieve pagina, niet alle 30+ lijsten
    const _ap = document.querySelector('.page.active');
    if(_ap && window.rebuildPage) window.rebuildPage(_ap.id);
    if(window.refreshAll) window.refreshAll();
    if(window.rebuildNameDropdown) window.rebuildNameDropdown();
    if(window.renderOdLog) window.renderOdLog();
    if(flashSet.size > 0) flashRemoteItems(flashSet, merged);
    setSyncStatus("synced");
  }

  function detectConflicts(flashSet, preLocal, merged){
    const myUser = window.getCurrentUser?.();
    if(!myUser) return;
    const now = Date.now();
    const camSections = new Set(['pc','sl','sm','c14']);
    const conflictUsers = new Set();
    for(const path of flashSet){
      const parts = path.split('/');
      const sk = parts[0];
      let localEntry, remoteUser;
      if(camSections.has(sk)){
        localEntry = (preLocal[sk]||{})[parts[1]]?.[parts[2]];
        remoteUser = (merged[sk]||{})[parts[1]]?.[parts[2]]?.user;
      } else if(!sk.startsWith('comm_')){
        localEntry = (preLocal[sk]||{})[parts[1]];
        remoteUser = (merged[sk]||{})[parts[1]]?.user;
      }
      // Conflict: ik heb dit item <60s geleden gewijzigd, maar remote heeft een andere waarde weggeschreven
      if(localEntry?.ts && now - localEntry.ts < 60000 &&
         localEntry.user === myUser && remoteUser && remoteUser !== myUser){
        conflictUsers.add(remoteUser);
      }
    }
    if(conflictUsers.size > 0){
      showConflictToast([...conflictUsers].join(', '));
    }
  }

  // ── PUSH: broadcast instantly + debounced DB write ──────────
  let offlineQueue  = null; // last data to sync when back online
  let pendingRemote = null; // remote update received during suppress window

  window.pushToSupabase = function(data, changedKey){
    if(!supaClient) return;

    // 1. Broadcast: partial if changedKey — bespaart bandbreedte op 3G/4G
    if(broadcastChannel){
      const broadcastPayload = changedKey
        ? { [changedKey]: data[changedKey], _lastUpdate: data._lastUpdate }
        : data;
      broadcastChannel.send({
        type: "broadcast",
        event: "state_update",
        payload: { data: broadcastPayload }
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
        // Lees DB eerst: bewaar de nieuwste _users als die in DB nieuwer is dan lokaal.
        // Voorkomt dat een volle push van een teamlid de net-toegevoegde gebruikerslijst overschrijft.
        let dataToSave = offlineQueue;
        try{
          const { data: cur } = await supaClient.from("checklist_state").select("data").eq("id",1).single();
          if(cur?.data && (cur.data._usersTs||0) > (dataToSave._usersTs||0)){
            dataToSave = Object.assign({}, dataToSave, { _users: cur.data._users, _usersTs: cur.data._usersTs });
            if(window._localSaveRaw) window._localSaveRaw(dataToSave);
          }
        } catch(e){}
        const _ctrl = new AbortController();
        const _to = setTimeout(()=>_ctrl.abort(), 10000);
        const { error } = await supaClient.from("checklist_state")
          .upsert({ id:1, data: dataToSave }, { onConflict:"id" })
          .abortSignal(_ctrl.signal);
        clearTimeout(_to);
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
          showToast("Opslaan mislukt — wijzigingen worden lokaal bewaard.", { retry: true, persist: true });
        } else if(pushFailCount >= 3){
          showToast("Verbinding verbroken. Controleer je internet.", { retry: true, persist: true });
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

  // Flush queue when coming back online — merge with remote first to avoid overwriting concurrent changes
  window.addEventListener("online", async ()=>{
    setSyncStatus("connected");
    const localData = offlineQueue || (localStorage.getItem('rg_pending_sync') ? (window._localLoad ? window._localLoad() : {}) : null);
    if(!localData) return;
    try{
      const { data: row } = await supaClient.from("checklist_state").select("data").eq("id",1).single();
      if(row?.data){
        const merged = deepMerge(localData, row.data);
        if(window._localSaveRaw) window._localSaveRaw(merged);
        window.pushToSupabase(merged);
      } else {
        window.pushToSupabase(localData);
      }
    } catch(e){
      // Fetch failed — push local as fallback (original behaviour)
      window.pushToSupabase(localData);
    }
  });
  window.addEventListener("offline", ()=>{ setSyncStatus("offline"); });

  function startSync(){
    if(!supaClient) return;

    // ── Broadcast channel (instant peer-to-peer) ──────────────
    // Postgres_changes channel verwijderd: stuurde bij elke DB-write de
    // volledige ~80KB rij naar alle clients. In plaats daarvan doen we
    // een gerichte DB-pull alleen wanneer de broadcast-channel opnieuw
    // verbinding maakt na een onderbreking.
    let _wasDisconnected = false;
    broadcastChannel = supaClient.channel("rg-live-updates");
    broadcastChannel
      .on("broadcast", { event: "state_update" }, ({ payload })=>{
        if(!payload?.data) return;
        setSyncStatus("receiving");
        applyRemote(payload.data);
      })
      .on("broadcast", { event: "celebrate" }, ()=>{
        let seen = false;
        try{ seen = sessionStorage.getItem('rg_seen_celebration')==='1'; }catch(e){}
        if(!seen) setTimeout(()=>window.triggerAvatarCelebration?.(), 800);
      })
      .subscribe(status=>{
        if(status === "SUBSCRIBED"){
          setSyncStatus("synced");
          if(_wasDisconnected){
            // Reconnect na onderbreking: pull meest recente DB-state om
            // gemiste broadcast-berichten te compenseren
            _wasDisconnected = false;
            const _rc = new AbortController();
            setTimeout(()=>_rc.abort(), 8000);
            supaClient.from("checklist_state").select("data").eq("id",1).single().abortSignal(_rc.signal)
              .then(({data: row})=>{ if(row?.data && !suppressRemote) applyRemote(row.data); }).catch(()=>{});
          }
        }
        if(status === "CLOSED" || status === "CHANNEL_ERROR"){
          setSyncStatus("offline");
          _wasDisconnected = true;
        }
      });

    // ── Pull latest state on first connect ────────────────────
    (async ()=>{
      const ctrl = new AbortController();
      const to = setTimeout(()=>ctrl.abort(), 8000);
      try{
        const { data: row, error } = await supaClient.from("checklist_state")
          .select("data").eq("id",1).single().abortSignal(ctrl.signal);
        clearTimeout(to);
        if(error) throw error;
        if(row?.data) applyRemote(row.data);
        seedDefaultUsers();
        if(localStorage.getItem('rg_pending_sync')){
          const current = window._localLoad ? window._localLoad() : {};
          window.pushToSupabase(current);
          showToast("Offline wijzigingen gesynchroniseerd.");
        }
        setSyncStatus("synced");
        window._dataReady = true;
        if(window.refreshAll) window.refreshAll();
      } catch(e){
        clearTimeout(to);
        setSyncStatus("error");
        showToast("Server niet bereikbaar — lokale data wordt gebruikt.");
        window._dataReady = true;
        if(window.refreshAll) window.refreshAll();
      }
    })();
  }

  let pushFailCount = 0;

  function showToast(msg, opts={}){
    let el = document.getElementById("sync-toast");
    if(!el){
      el = document.createElement("div");
      el.id = "sync-toast";
      el.style.cssText = "position:fixed;bottom:72px;left:50%;transform:translateX(-50%);background:#C1440E;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.3);transition:opacity .3s;text-align:center;max-width:90vw;";
      document.body.appendChild(el);
    }
    if(opts.retry){
      el.innerHTML = `${msg} <button onclick="window._retrySync&&window._retrySync()" style="margin-left:10px;background:rgba(255,255,255,.25);border:1px solid rgba(255,255,255,.5);color:#fff;font-family:inherit;font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;">Opnieuw</button>`;
    } else {
      el.textContent = msg;
    }
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(()=>{ el.style.opacity = "0"; }, opts.persist ? 12000 : 4000);
  }

  function showConflictToast(who){
    let el = document.getElementById("conflict-toast");
    if(!el){
      el = document.createElement("div");
      el.id = "conflict-toast";
      el.style.cssText = "position:fixed;top:72px;right:14px;background:#C9A84C;color:#1A1208;padding:9px 14px;border-radius:8px;font-size:12px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.25);transition:opacity .3s;max-width:260px;line-height:1.4;";
      document.body.appendChild(el);
    }
    el.textContent = `⚠️ Conflict: ${who} heeft hetzelfde item tegelijk gewijzigd. Nieuwste versie is opgeslagen.`;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(()=>{ el.style.opacity = "0"; }, 7000);
  }

  window._retrySync = function(){
    const d = window._localLoad ? window._localLoad() : {};
    if(window.pushToSupabase) window.pushToSupabase(d);
  };

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

  // Gedeelde AudioContext — één instantie, nooit sluiten.
  // iOS Safari staat max ~12 contexts toe; elke new AudioContext() per geluidje loopt die vol.
  let _audioCtx = null;
  function _getAudioCtx(){
    try{
      if(!_audioCtx || _audioCtx.state === 'closed')
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if(_audioCtx.state === 'suspended') _audioCtx.resume();
      return _audioCtx;
    } catch(e){ return null; }
  }

  function playCheckTick(){
    const ctx = _getAudioCtx(); if(!ctx) return;
    try{
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
    } catch(e){}
  }
  window.playCheckTick = playCheckTick;

  function playSyncChime(){
    const ctx = _getAudioCtx(); if(!ctx) return;
    try{
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
    } catch(e){}
  }

  window._sendCelebrateBroadcast = function(){
    if(!broadcastChannel) return;
    broadcastChannel.send({ type:'broadcast', event:'celebrate', payload:{} }).catch(()=>{});
  };

  function playFanfare(){
    const ctx = _getAudioCtx(); if(!ctx) return;
    try{
      const notes = [
        { freq:523,  t:0,    dur:0.14, vol:0.28 },
        { freq:659,  t:0.13, dur:0.14, vol:0.28 },
        { freq:784,  t:0.26, dur:0.14, vol:0.28 },
        { freq:1047, t:0.39, dur:0.9,  vol:0.32 },
        { freq:784,  t:0.44, dur:0.75, vol:0.22 },
        { freq:523,  t:0.44, dur:0.75, vol:0.18 },
      ];
      notes.forEach(({freq,t,dur,vol})=>{
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0, ctx.currentTime+t);
        gain.gain.linearRampToValueAtTime(vol, ctx.currentTime+t+0.02);
        gain.gain.setValueAtTime(vol, ctx.currentTime+t+dur-0.06);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+t+dur);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime+t);
        osc.connect(gain);
        osc.start(ctx.currentTime+t);
        osc.stop(ctx.currentTime+t+dur+0.02);
      });
    } catch(e){}
  }
  window.playFanfare = playFanfare;

  document.addEventListener("DOMContentLoaded", ()=>{
    setTimeout(()=>window.initSupabase(), 300);
  });

})();



// ── AUDIO STAGEBOX DATA ──────────────────────────────────────────
const PC_SB_ITEMS  = ['A-STAGE64 NORTH PIT','A-STAGE64 SOUTH TRIBUNE','A-MIC8 WEST TRIBUNE','A-MIC8 EAST TRIBUNE'];
const SL_SB_ITEMS  = ['A-STAGE64 SOUTH PIT','A-MIC8 SOUTH EAST TOWER','A-MIC8 SOUTH WEST TOWER','A-MIC8 CAM 2'];
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
const GFX_ITEMS = ["GFX 1", "GFX 2"];


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
  {num:26,type:"Handheld · xWA",pos:"Persco interview"},
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

// ── CAM Checklist (Excel matrix) ─────────────────────────────────
const CAM_CHECK_GROUPS = [
  {label:'FIBER',         checks:['CAM','CCU']},
  {label:'FIBERS SONO',   checks:['SONO-CAM','SONO-CCU']},
  {label:'FIBERS PERSCO', checks:['PERSCO-CAM','PERSCO-CCU']},
  {label:'FIBERS COMM',   checks:['COMM-CAM','COMM-CCU']},
  {label:'FIBERS FINALS', checks:['FINALS-CAM','FINALS-CCU']},
  {label:'CONTROL',       checks:['IRIS','Back-focus']},
  {label:'VIDEO',    checks:['UHD','HDR','SDR']},
  {label:'RETURN',   checks:['RET 1','RET 2','RET 3']},
  {label:'TALLY',    checks:['RED']},
  {label:'INTERCOM', checks:['PROD','ENG','PGM']},
  {label:'AUDIO',    checks:['IN 1','IN 2']},
];
const ALL_CAM_CHECKS = ['CAM','CCU','IRIS','Back-focus','UHD','HDR','SDR','RET 1','RET 2','RET 3','RED','PROD','ENG','PGM','IN 1','IN 2']; // 16 items

// Check sets per camera type
const CHK_ALL  = ALL_CAM_CHECKS;
const CHK_14   = ['CAM','CCU','IRIS','Back-focus','UHD','HDR','SDR','RET 1','RET 2','RET 3','RED','PROD','ENG','PGM'];
const CHK_RF8  = ['IRIS','UHD','HDR','SDR','RED','PROD','ENG','PGM'];
const CHK_HH11 = ['IRIS','UHD','HDR','SDR','RET 1','RET 2','RET 3','RED','PROD','ENG','PGM'];
const CHK_HH   = ['IRIS','UHD','HDR','SDR','RED','PROD','ENG','PGM'];
const CHK_PTZ4 = ['IRIS','UHD','HDR','SDR'];
const CHK_SM_HH  = ['IRIS','HDR','SDR','RED','PROD','ENG','PGM'];
const CHK_SM15   = ['CAM','CCU','IRIS','Back-focus','HDR','SDR','RET 1','RET 2','RET 3','RED','PROD','ENG','PGM','IN 1','IN 2'];
const CHK_SM13   = ['CAM','CCU','IRIS','Back-focus','HDR','SDR','RET 1','RET 2','RET 3','RED','PROD','ENG','PGM'];
const CHK_SM_RF  = ['IRIS','HDR','SDR','RED','PROD','ENG','PGM'];
const CHK_SM3    = ['IRIS','HDR','SDR'];
const CHK_CT14HH = ['IRIS','HDR','SDR','RET 1','RET 2','RET 3','RED','PROD','ENG','PGM','IN 1','IN 2'];
const CHK_CT14RF = ['IRIS','RED','PROD','ENG','PGM'];

const CAMCHECK_PC = [
  {id:'PC.01',mcs:'1', type:'3500',     checks:CHK_ALL},
  {id:'PC.02',mcs:'2', type:'3500',     checks:CHK_14},
  {id:'PC.03',mcs:'3', type:'3500',     checks:CHK_14},
  {id:'PC.04',mcs:'4', type:'3500',     checks:CHK_14},
  {id:'PC.05',mcs:'32',type:'SSM',      checks:CHK_14},
  {id:'PC.06',mcs:'37',type:'SSM',      checks:CHK_14},
  {id:'PC.07',mcs:'-', type:'RF',       checks:CHK_RF8},
  {id:'PC.08',mcs:'31',type:'UM',       checks:CHK_14},
  {id:'PC.09',mcs:'5', type:'3500',     checks:CHK_14},
  {id:'PC.10',mcs:'40',type:'HOTHEAD',  checks:CHK_HH},
  {id:'PC.11',mcs:'',  type:'SPIDER',   checks:CHK_PTZ4},
  {id:'PC.12',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'PC.13',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'PC.14',mcs:'',  type:'PLAYERBOX',checks:CHK_PTZ4},
  {id:'PC.15',mcs:'',  type:'PLAYERBOX',checks:CHK_PTZ4},
  {id:'PC.16',mcs:'',  type:'NETCAM',   checks:CHK_PTZ4},
  {id:'PC.17',mcs:'',  type:'NETCAM',   checks:CHK_PTZ4},
  {id:'PC.18',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'PC.19',mcs:'6', type:'3500',     checks:CHK_14},
  {id:'PC.20',mcs:'',  type:'RF',       checks:CHK_RF8},
  {id:'PC.21',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'PC.22',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'PC.23',mcs:'7', type:'3500',     checks:['SONO-CAM','SONO-CCU','PERSCO-CAM','PERSCO-CCU','COMM-CAM','COMM-CCU','FINALS-CAM','FINALS-CCU','IRIS','Back-focus','UHD','HDR','SDR','RET 1','RET 2','RET 3','RED','PROD','ENG','PGM']},
  {id:'PC.24',mcs:'8', type:'3500',     checks:CHK_14},
  {id:'PC.26',mcs:'45',type:'3500',     checks:CHK_14},
];
const CAMCHECK_SL = [
  {id:'SL.01',mcs:'9', type:'3500',     checks:CHK_ALL},
  {id:'SL.02',mcs:'10',type:'3500',     checks:CHK_14},
  {id:'SL.03',mcs:'11',type:'3500',     checks:CHK_14},
  {id:'SL.04',mcs:'12',type:'3500',     checks:CHK_14},
  {id:'SL.05',mcs:'34',type:'SSM',      checks:CHK_14},
  {id:'SL.06',mcs:'38',type:'SSM',      checks:CHK_14},
  {id:'SL.07',mcs:'',  type:'RF',       checks:CHK_RF8},
  {id:'SL.08',mcs:'33',type:'UM',       checks:CHK_14},
  {id:'SL.09',mcs:'13',type:'3500',     checks:CHK_14},
  {id:'SL.10',mcs:'41',type:'HOTHEAD',  checks:CHK_HH},
  {id:'SL.11',mcs:'',  type:'SPIDER',   checks:CHK_PTZ4},
  {id:'SL.12',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'SL.13',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'SL.14',mcs:'',  type:'PLAYERBOX',checks:CHK_PTZ4},
  {id:'SL.15',mcs:'',  type:'PLAYERBOX',checks:CHK_PTZ4},
  {id:'SL.16',mcs:'',  type:'NETCAM',   checks:CHK_PTZ4},
  {id:'SL.17',mcs:'',  type:'NETCAM',   checks:CHK_PTZ4},
  {id:'SL.18',mcs:'',  type:'PTZ',      checks:CHK_PTZ4},
  {id:'SL.19',mcs:'14',type:'3500',     checks:CHK_ALL},
  {id:'SL.20',mcs:'15',type:'3500',     checks:CHK_14},
];
const CAMCHECK_SM = [
  {id:'SM.01',mcs:'42',type:'HOTHEAD',  checks:CHK_SM_HH},
  {id:'SM.02',mcs:'16',type:'3500',     checks:CHK_SM15},
  {id:'SM.03',mcs:'17',type:'3500',     checks:CHK_SM13},
  {id:'SM.04',mcs:'18',type:'3500',     checks:CHK_SM13},
  {id:'SM.05',mcs:'35',type:'SSM',      checks:CHK_SM13},
  {id:'SM.06',mcs:'36',type:'UM',       checks:CHK_SM13},
  {id:'SM.07',mcs:'',  type:'RF',       checks:CHK_SM_RF},
  {id:'SM.08',mcs:'',  type:'PTZ',      checks:CHK_SM3},
  {id:'SM.09',mcs:'',  type:'PTZ',      checks:CHK_SM3},
  {id:'SM.10',mcs:'',  type:'NETCAM',   checks:CHK_SM3},
  {id:'SM.11',mcs:'',  type:'NETCAM',   checks:CHK_SM3},
  {id:'SM.12',mcs:'19',type:'3500',     checks:CHK_SM15},
  {id:'SM.13',mcs:'20',type:'3500',     checks:CHK_SM13},
];
const CAMCHECK_CT14 = [
  {id:'CT14.01',mcs:'43',type:'HOTHEAD',checks:CHK_SM_HH},
  {id:'CT14.02',mcs:'21',type:'3500',   checks:CHK_SM15},
  {id:'CT14.03',mcs:'22',type:'3500',   checks:CHK_SM13},
  {id:'CT14.04',mcs:'23',type:'3500',   checks:CHK_SM13},
  {id:'CT14.05',mcs:'24',type:'3500',   checks:CHK_SM13},
  {id:'CT14.06',mcs:'39',type:'SSM',    checks:CHK_SM13},
  {id:'CT14.07',mcs:'',  type:'RF',     checks:CHK_CT14RF},
  {id:'CT14.08',mcs:'25',type:'3500',   checks:CHK_SM13},
];

const SK = "rg2026_v1";
let _dataCache = null;
function load(){
  if(_dataCache !== null) return _dataCache;
  try{ _dataCache = JSON.parse(localStorage.getItem(SK))||{}; }catch{ _dataCache = {}; }
  return _dataCache;
}
function _localSaveRaw(d){
  _dataCache = d;
  try{
    localStorage.setItem(SK, JSON.stringify(d));
  } catch(e){
    if(e?.name==='QuotaExceededError' || e?.code===22 || e?.code===1014){
      // Show persistent warning — do NOT silently swallow
      const el = document.getElementById('sync-toast') || document.createElement('div');
      el.id = 'sync-toast';
      el.style.cssText = 'position:fixed;bottom:72px;left:50%;transform:translateX(-50%);background:#C1440E;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.3);text-align:center;max-width:90vw;';
      el.textContent = '⚠️ Opslag vol — wijzigingen staan wel in Supabase maar niet lokaal.';
      if(!el.parentNode) document.body.appendChild(el);
    }
  }
}
window._localLoad = load;
window._localSaveRaw = _localSaveRaw;

function save(d, changedKey){
  d._lastUpdate = Date.now();
  _localSaveRaw(d);
  updateLastUpdateLabel();
  if(window.pushToSupabase) window.pushToSupabase(d, changedKey);
}
function getCurrentUser(){
  const u = localStorage.getItem("rg_user")||"";
  if(!u) return null;
  const users = getUsers();
  return users.length === 0 || users.includes(u) ? u : null;
}
function setCurrentUser(n){ localStorage.setItem("rg_user",n); }
function _requireLogin(){
  if(getCurrentUser()) return true;
  showToast('⚠️ Log eerst in voordat je items afvinkt');
  return false;
}
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

// ── Screen Wake Lock — scherm blijft aan tijdens gebruik ─────────
let _wakeLock = null;
async function acquireWakeLock(){
  if(!('wakeLock' in navigator)) return;
  try{
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', ()=>{ _wakeLock = null; });
  } catch(e){}
}
function releaseWakeLock(){
  if(_wakeLock){ _wakeLock.release(); _wakeLock = null; }
}
// Heractiveer na tab-switch (spec vereist dit)
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && load().loggedIn) acquireWakeLock();
});

let _handlingPop = false;
const FILTER_PAGES = new Set([
  'page-pc','page-sl','page-sm','page-c14',
  'page-audio-pc','page-audio-sl','page-audio-sm','page-audio-c14',
  'page-comm-pc4th','page-comm-pc5th','page-comm-sl','page-comm-sm',
  'page-galleries','page-courts',
]);

function _updateFilterBtn(pageId){
  let btn = document.getElementById('filter-btn');
  let colBtn = document.getElementById('collapse-all-btn');
  const isCamCheck = pageId && (pageId.startsWith('page-camcheck-') || ['page-pc','page-sl','page-sm','page-c14'].includes(pageId));
  const isFilter = FILTER_PAGES.has(pageId) || (pageId && pageId.startsWith('page-gal-'));

  if(isFilter){
    if(!btn){
      btn = document.createElement('button');
      btn.id = 'filter-btn';
      btn.textContent = 'Open';
      btn.onclick = () => {
        const active = document.querySelector('.page.active');
        if(!active) return;
        active.classList.toggle('show-open-only');
        btn.classList.toggle('active', active.classList.contains('show-open-only'));
      };
      const subHeader = document.querySelector('.page.active .sub-header-inner');
      if(subHeader) subHeader.appendChild(btn);
    }
    btn.classList.remove('active');
    document.querySelector('.page.active')?.classList.remove('show-open-only');
  } else {
    if(btn) btn.remove();
  }

  if(isCamCheck){
    if(!colBtn){
      colBtn = document.createElement('button');
      colBtn.id = 'collapse-all-btn';
      colBtn.textContent = '⊟';
      colBtn.title = 'Alles inklappen';
      colBtn.onclick = () => {
        const active = document.querySelector('.page.active');
        if(!active) return;
        const blocks = active.querySelectorAll('.cam-block');
        const anyOpen = Array.from(blocks).some(b => !b.classList.contains('collapsed'));
        blocks.forEach(b => {
          const body = b.querySelector('.cam-body');
          if(anyOpen){ b.classList.add('collapsed'); if(body) body.style.maxHeight='0'; }
          else { b.classList.remove('collapsed'); if(body) body.style.maxHeight='1200px'; }
        });
        colBtn.textContent = anyOpen ? '⊞' : '⊟';
        colBtn.title = anyOpen ? 'Alles uitklappen' : 'Alles inklappen';
      };
      const subHeader = document.querySelector('.page.active .sub-header-inner');
      if(subHeader) subHeader.appendChild(colBtn);
    }
  } else {
    if(colBtn) colBtn.remove();
  }

  // Probleem-knop: altijd aanwezig behalve op home/login
  document.getElementById('quick-prob-btn')?.remove();
  if(pageId && pageId !== 'page-home' && pageId !== 'page-login'){
    const probBtn = document.createElement('button');
    probBtn.id = 'quick-prob-btn';
    probBtn.className = 'quick-prob-sub-btn';
    probBtn.title = 'Probleem melden';
    probBtn.textContent = '⚠';
    probBtn.onclick = openQuickProb;
    const subHdr = document.querySelector('.page.active .sub-header-inner');
    if(subHdr) subHdr.appendChild(probBtn);
  }
}

function goTo(id){
  closeLightbox();
  const d = load();
  if(id !== 'page-login' && !d.loggedIn){
    id = 'page-login';
  }
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  const el = document.getElementById(id);
  if(el) el.classList.add("active");
  window.scrollTo(0,0);
  if(!_handlingPop && history.state?.page !== id){
    history.pushState({ page: id }, '', location.pathname + location.search);
  }
  refreshAll();
  rebuildPage(id);
  _updateFilterBtn(id);
  _updateCourtDots(id);
  if(id === 'page-overdracht') setOdLastRead();
  // Resize textareas met bestaande inhoud na pagina-wissel
  requestAnimationFrame(()=>{ document.querySelectorAll('textarea').forEach(resizeTextarea); });
}

// Emails zijn alleen identifiers voor Supabase Auth — geen echte mailbox nodig.
// Maak deze gebruikers aan in Supabase Dashboard → Authentication → Users.
const TEAM_AUTH_EMAIL  = "team@rg2026.app";
const ADMIN_AUTH_EMAIL = "admin@rg2026.app";
const ADMIN_USERS = ["Pim"];
function _updateAdminBtn(){
  const btn = document.getElementById('admin-btn');
  if(btn) btn.style.display = ADMIN_USERS.includes(getCurrentUser()) ? '' : 'none';
  updateAccessRequestBadge();
}
function _isAdmin(){ return window._adminMode && ADMIN_USERS.includes(getCurrentUser()); }
const VAPID_PUBLIC_KEY = 'VPwCZa_ig9uZ9bEPhnuhndWyNvoYwj-VfbY8hjp77qx-EtBRi-vN_wPzKhjqjwbDxRef2NwjoRaLEYzGOFf1Gw';

async function _subscribePush(userName){
  try{
    if(!('PushManager' in window) || !('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub){
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: VAPID_PUBLIC_KEY,
      });
    }
    // Sla op in Supabase (upsert op endpoint)
    if(window._supaClient){
      await window._supaClient.from('push_subscriptions').upsert({
        user_name: userName,
        subscription: sub.toJSON(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'endpoint' });
    }
  } catch(e){ console.warn('Push subscribe mislukt:', e); }
}

async function _sendPushCourtDone(courtLabel, user){
  try{
    const url = `${window._SUPABASE_URL}/functions/v1/send-push`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${window._SUPABASE_KEY}` },
      body: JSON.stringify({
        title: `✓ ${courtLabel} — 100% klaar`,
        body: `${user || 'Iemand'} heeft ${courtLabel} volledig afgevinkt`,
        sender: user,
      }),
    });
  } catch(e){ console.warn('Push court-klaar mislukt:', e); }
}

async function _sendPushOverdracht(sender, shiftLabel){
  try{
    const url = `${window._SUPABASE_URL}/functions/v1/send-push`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${window._SUPABASE_KEY}` },
      body: JSON.stringify({
        title: '📋 Nieuwe overdracht — RG 2026',
        body: `${sender || 'Iemand'} heeft een ${shiftLabel}-overdracht geschreven`,
        sender,
      }),
    });
  } catch(e){ console.warn('Push versturen mislukt:', e); }
}

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
    acquireWakeLock();
    goTo('page-home');
    _updateAdminBtn();
    setTimeout(initPresence, 800);
    if(name) setTimeout(()=> _subscribePush(name), 2000);
  } else {
    inp.style.borderColor = "#C1440E";
    inp.value = "";
    inp.placeholder = "Fout: " + (authError.message || "Onjuist wachtwoord");
    console.error("Auth fout:", authError);
    setTimeout(()=>{ inp.style.borderColor=""; inp.placeholder="Wachtwoord"; }, 3000);
  }
}

function logout(){
  if(_sessionCheckInterval){ clearInterval(_sessionCheckInterval); _sessionCheckInterval = null; }
  releaseWakeLock();
  try {
    // Fire a final sync if there are pending changes before we navigate away
    if(localStorage.getItem('rg_pending_sync') && window.pushToSupabase && navigator.onLine){
      window.pushToSupabase(load());
    }
    const d = load();
    delete d.loggedIn;
    localStorage.setItem(SK, JSON.stringify(d));
  } catch(e){}
  window._adminMode = false;
  try{ sessionStorage.removeItem('rg_admin'); }catch(e){}
  if(navigator.vibrate) navigator.vibrate(20);
  _updateAdminBtn();
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
  buildSimpleList("list-gal-GFX","gal_GFX",GFX_ITEMS);
  buildCamPage("list-c14","c14",C14_CAMS);
  buildCamPage("list-pc","pc",PC_CAMS);
  buildCamPage("list-sl","sl",SL_CAMS);
  buildCamPage("list-sm","sm",SM_CAMS);
  buildCamCheckPage("list-camcheck-pc","camck_pc",CAMCHECK_PC);
  buildCamCheckPage("list-camcheck-sl","camck_sl",CAMCHECK_SL);
  buildCamCheckPage("list-camcheck-sm","camck_sm",CAMCHECK_SM);
  buildCamCheckPage("list-camcheck-c14","camck_c14",CAMCHECK_CT14);
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

// Herbouw alleen de lijst voor de opgegeven pagina.
// Aangeroepen vanuit goTo() en applyRemote() — niet meer buildAllLists() bij elke sync.
window.rebuildPage = function rebuildPage(id){
  switch(id){
    case 'page-pc':              buildCamPage("list-pc","pc",PC_CAMS); break;
    case 'page-sl':              buildCamPage("list-sl","sl",SL_CAMS); break;
    case 'page-sm':              buildCamPage("list-sm","sm",SM_CAMS); break;
    case 'page-c14':             buildCamPage("list-c14","c14",C14_CAMS); break;
    case 'page-camcheck-pc':     buildCamCheckPage("list-camcheck-pc","camck_pc",CAMCHECK_PC); break;
    case 'page-camcheck-sl':     buildCamCheckPage("list-camcheck-sl","camck_sl",CAMCHECK_SL); break;
    case 'page-camcheck-sm':     buildCamCheckPage("list-camcheck-sm","camck_sm",CAMCHECK_SM); break;
    case 'page-camcheck-c14':    buildCamCheckPage("list-camcheck-c14","camck_c14",CAMCHECK_CT14); break;
    case 'page-audio-pc':
    case 'page-audio-sl':
    case 'page-audio-sm':
    case 'page-audio-c14':   buildAudioLists(); break;
    case 'page-comm-pc4th':  buildPosList("list-comm-pc4th","comm_pc4th",PC4TH_POSITIONS); break;
    case 'page-comm-pc5th':  buildPosList("list-comm-pc5th","comm_pc5th",PC5TH_POSITIONS); break;
    case 'page-comm-sl':     buildPosList("list-comm-sl","comm_sl",COMMSL_POSITIONS); break;
    case 'page-comm-sm':     buildPosList("list-comm-sm","comm_sm",COMMSM_POSITIONS); break;
    case 'page-galleries':   buildGallery(); break;
    case 'page-overdracht':  buildOverdracht(); break;
    case 'page-users':       if(!_isAdmin()){ goTo('page-home'); return; } buildUsers(); break;
    case 'page-problems':    buildProblems(); break;
    case 'page-persons':     buildPersons(); break;
    case 'page-activity':    buildActivity(); break;
    default:
      if(id && id.startsWith('page-gal-')){
        const key = id.slice(9);
        const sk  = 'gal_' + key.replace(/-/g,'_');
        const items = window[key.replace(/-/g,'_') + '_ITEMS'];
        if(items) buildSimpleList('list-gal-' + key, sk, items);
      }
  }
};

function showOfflineBanner(){
  if(document.getElementById('offline-banner')) return;
  const b = document.createElement('div');
  b.id = 'offline-banner';
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#C1440E;color:#fff;text-align:center;padding:10px 16px;font-size:13px;z-index:10000;';
  b.textContent = 'Geen internetverbinding — de app werkt offline maar synchroniseert niet.';
  document.body.appendChild(b);
}
window.addEventListener('online',  ()=>{ document.getElementById('offline-banner')?.remove(); });
window.addEventListener('offline', ()=>showOfflineBanner());

// Service worker stuurt dit als gebruiker op notificatie tikt terwijl app dicht was
navigator.serviceWorker?.addEventListener('message', e => {
  if(e.data?.type === 'open-overdracht') { buildOverdracht(); goTo('page-overdracht'); }
});

function initApp(){
  // Restore admin session across page reloads
  try{ if(sessionStorage.getItem('rg_admin')==='1' && ADMIN_USERS.includes(getCurrentUser())) window._adminMode = true; }catch(e){}


  // Apply saved theme immediately before anything renders
  const savedTheme = localStorage.getItem('rg_theme');
  if(savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  const darkBtn = document.querySelector('.dark-toggle');
  if(darkBtn) darkBtn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';

  // User label
  const saved = getCurrentUser();
  const userLbl = document.getElementById('logged-in-user');
  if(userLbl && saved) userLbl.textContent = '👤 ' + saved;
  const avEl = document.getElementById('user-bar-avatar');
  if(avEl && saved){
    const av = getUserAvatar(saved);
    avEl.innerHTML = av ? `<img src="${av}" class="userbar-avatar" alt="${saved}" title="${saved}">` : '';
  }
  _updateAdminBtn();
  updateLastUpdateLabel();

  if(!navigator.onLine) showOfflineBanner();

  buildAllLists();
  var d = load();

  // Pre-seed _courtWasDone from current data so courts that were already
  // complete before this page load don't re-fire the toast.
  const _courtMap = {c14:C14_CAMS,pc:PC_CAMS,sl:SL_CAMS,sm:SM_CAMS};
  for(const [sk, cams] of Object.entries(_courtMap)){
    _courtWasDone[sk] = cams.every(cam =>
      getRows(sk, cam.num).every(r => (d[sk]||{})[`cam${cam.num}`]?.[r]?.checked)
    );
  }

  const SESSION_HOURS = 12;
  const lastActivity = parseInt(localStorage.getItem('rg_last_activity') || '0') || (d.loginTs || 0);
  const sessionExpired = lastActivity && (Date.now() - lastActivity) > SESSION_HOURS * 60 * 60 * 1000;
  if(d.loggedIn && !sessionExpired){
    goTo('page-home');
    setTimeout(initPresence, 1000);
    setTimeout(_showMiniGameBtn, 800);
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
let _sessionCheckInterval = null;
function _startSessionCheck(){
  if(_sessionCheckInterval) return;
  _sessionCheckInterval = setInterval(()=>{
    const d = load();
    if(!d.loggedIn) return;
    const lastActivity = parseInt(localStorage.getItem('rg_last_activity') || '0') || (d.loginTs || 0);
    if(Date.now() - lastActivity > 12 * 60 * 60 * 1000){
      logout();
      goTo('page-login');
    }
  }, 60 * 60 * 1000);
}
_startSessionCheck();

// Legacy toggle()/restoreChecks() verwijderd — vervangen door camToggle/simpleToggle/posToggle.
// Eenmalige migratie: verwijder verouderd d.checks object uit localStorage.
(function cleanLegacyChecks(){
  try{
    const raw = localStorage.getItem(SK);
    if(!raw) return;
    const d = JSON.parse(raw);
    if(d.checks){ delete d.checks; localStorage.setItem(SK, JSON.stringify(d)); _dataCache = d; }
  }catch(e){}
})();

function buildGallery(){
  const d = load();
  if(!d.gal) d.gal = {};
  const wrap = document.getElementById("gal-nav-list");
  if(!wrap) return;
  wrap.innerHTML = "";
  const keys = ['CCSR', 'CIR', 'MCR', 'INTERCOM', 'FFT', 'RF-CAMS', 'NOVA-105', 'SL-PRODUCTION', 'SL-AUDIO', 'SM-PRODUCTION', 'SM-AUDIO', 'EIC-AIC', 'EMG-OFFICE', 'EVS-SL', 'EVS-PC', 'QC-AUDIO', 'QC-PRODUCTION', 'GFX'];
  const labels = ['CCSR', 'CIR', 'MCR', 'INTERCOM', 'FFT', 'RF CAMS', 'NOVA 105', 'SL PRODUCTION', 'SL AUDIO', 'SM PRODUCTION', 'SM AUDIO', "EIC/AIC GALLERY'S", 'EMG OFFICE', 'EVS SL', 'EVS PC', 'QC AUDIO', 'QC PRODUCTION', 'GFX'];
  const notes = ['Camera Control Shading Room', '', 'Master Control Room', 'Comms', 'Fédération Française de Tennis', 'RF', 'EMG NOVA 105', 'Suzanne Lenglen Production', 'Suzanne Lenglen Audio', 'Simonne Mathieu Production', 'Simonne Mathieu Audio', 'Engineer In Charge / Audio In Charge', 'Kantoor', "Slomo's Suzanne Lenglen", "Slomo's Philippe Chatrier", 'Quality Control Audio', 'Quality Control Production', 'Graphics'];
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
  "QC-PRODUCTION":QC_PRODUCTION_ITEMS.length,
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
  "GFX":"gal_GFX"
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
    const rows = getRows(storageKey, cam.num);
    const checkedN = rows.filter(r=>cd[r]?.checked).length;
    const allDone = checkedN === rows.length && rows.length > 0;
    const collapsed = allDone;

    const rowsHTML = rows.map((row,j)=>{
      const rd = cd[row]||{};
      const isDone=rd.checked||false;
      const status=rd.status||"";
      const note=rd.note||"";
      const sc=status==="OK"?"s-ok":status==="NOK"?"s-nok":status==="PENDING"?"s-pend":"";
      return `<div class="cam-row${isDone?' row-done':''}" id="${containerId}-row-${cam.num}-${j}">
        <div class="cam-check-cell">
          <div class="cam-check-box${isDone?' on':''}${isDone&&note?' has-note':''}" onclick="camToggle('${storageKey}',${cam.num},'${row}',${j},'${containerId}',this)">
            <span class="ck">&#10003;</span>
          </div>
        </div>
        <div class="cam-row-label">
          ${row}${rd.ts?`<span class="row-meta">${esc(rd.user||"")}${rd.user?" · ":""}${fmtTime(rd.ts)}</span>`:""}
          ${note?`<span class="cam-note-pill">📝 ${esc(note.length>50?note.slice(0,50)+'…':note)}</span>`:""}
        </div>
        <textarea class="cam-note-input" rows="1" maxlength="500" placeholder="Notes…" oninput="camNote('${storageKey}',${cam.num},'${row}',this)">${esc(note)}</textarea>
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
        <span class="cam-note-dot" id="${containerId}-notedot-${cam.num}"></span>
        <span class="cam-pct" id="${containerId}-pct-${cam.num}">${checkedN}/${rows.length}</span>
        <span class="cam-arrow">&#9660;</span>
      </div>
      <div class="cam-body" style="max-height:${collapsed?'0':'1200px'}">
        ${rowsHTML}
        <div class="cam-pills" id="${containerId}-pills-${cam.num}">${pillsHTML}</div>
      </div>`;
    container.appendChild(block);

    const cdCheck = d[storageKey][ck]||{};
    if(getRows(storageKey, cam.num).every(r=>cdCheck[r]?.checked)){
      const hdr = block.querySelector(".cam-header");
      if(hdr) hdr.classList.add("cam-header-done");
    }
    const noteCount = rows.filter(r => !!(d[storageKey]?.[`cam${cam.num}`]?.[r]?.note)).length;
    if(noteCount > 0){
      const dot = block.querySelector('.cam-note-dot');
      if(dot){ dot.classList.add('has-note'); dot.textContent = '📝 '+noteCount; }
    }
  });
}

function pillHtml(sk, camNum){
  const d=load(); const cd=(d[sk]||{})[`cam${camNum}`]||{};
  const rows = getRows(sk, camNum);
  return rows.map(r=>{
    const s=cd[r]?.status||"";
    const [cls,lbl]=s==="OK"?["p-ok","OK"]:s==="NOK"?["p-nok","NOK"]:s==="PENDING"?["p-pend","…"]:["p-none","—"];
    return `<span class="pill ${cls}">${r}: ${lbl}</span>`;
  }).join("");
}

const _courtWasDone = {};
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

  // Check if the whole court just became complete
  const courtMap = {c14:C14_CAMS,pc:PC_CAMS,sl:SL_CAMS,sm:SM_CAMS};
  const courtLabels = {c14:"Court 14",pc:"Philippe-Chatrier",sl:"Suzanne-Lenglen",sm:"Simonne-Mathieu"};
  const cams = courtMap[sk]; if(!cams) return;
  const courtDone  = cams.every(cam => getRows(sk,cam.num).every(r=>(d[sk]||{})[`cam${cam.num}`]?.[r]?.checked));
  if(courtDone && !_courtWasDone[sk]){
    setTimeout(()=>{
      showCourtDoneToast(courtLabels[sk]);
      if(navigator.vibrate) navigator.vibrate([40,80,40,80,40]);
    }, 500);
  }
  _courtWasDone[sk] = courtDone;
}

function showCourtDoneToast(label){
  let el = document.getElementById("court-done-toast");
  if(!el){
    el = document.createElement("div");
    el.id = "court-done-toast";
    el.style.cssText = "position:fixed;bottom:72px;left:50%;transform:translateX(-50%);background:#2D5A1B;color:#fff;padding:12px 22px;border-radius:10px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .4s;text-align:center;max-width:90vw;pointer-events:none;";
    document.body.appendChild(el);
  }
  el.textContent = `✅ ${label} — alle cameras klaar!`;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.style.opacity = "0"; }, 6000);
}

function camCollapse(cid, camNum){
  const block=document.getElementById(`${cid}-block-${camNum}`);
  const body=block.querySelector(".cam-body");
  const now=block.classList.toggle("collapsed");
  body.style.maxHeight=now?"0":"1200px";
  const d=load(); const sk=cid.replace(/^list-/,"").replace(/-/g,"_");
  if(!d[sk]) d[sk]={}; if(!d[sk][`cam${camNum}`]) d[sk][`cam${camNum}`]={};
  d[sk][`cam${camNum}`].collapsed=now; save(d);
}

function camToggle(sk, camNum, row, j, cid, boxEl){
  if(!_requireLogin()) return;
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
  save(d, sk);

  const labelEl = document.querySelector(`#${cid}-row-${camNum}-${j} .cam-row-label`);
  if(labelEl){
    let metaEl = labelEl.querySelector('.row-meta');
    if(isDone){
      if(!metaEl){ metaEl = document.createElement('span'); metaEl.className='row-meta'; labelEl.appendChild(metaEl); }
      metaEl.textContent = (getCurrentUser()||"")+(getCurrentUser()?" · ":"")+fmtTime(Date.now());
    } else if(metaEl){ metaEl.textContent = ""; }
  }

  const selEl = document.querySelector(`#${cid}-row-${camNum}-${j} .cam-status-sel`);
  if(selEl){ selEl.value=newStatus; selEl.className="cam-status-sel"+(isDone?" s-ok":""); }
  const hasNote = !!(d[sk]?.[`cam${camNum}`]?.[row]?.note);
  boxEl.classList.toggle("has-note", isDone && hasNote);

  const cd=d[sk][`cam${camNum}`]||{};
  const _rows=getRows(sk,camNum);
  const n=_rows.filter(r=>cd[r]?.checked).length;
  const pEl=document.getElementById(`${cid}-pct-${camNum}`); if(pEl) pEl.textContent=n+"/"+_rows.length;

  const pillEl=document.getElementById(`${cid}-pills-${camNum}`); if(pillEl) pillEl.innerHTML=pillHtml(sk,camNum);

  checkCamComplete(sk, camNum, cid, d);
  refreshAll();
}

function camStatus(sk, camNum, row, j, cid, sel){
  if(!_requireLogin()){
    const d=load(); const prev=(d[sk]||{})[`cam${camNum}`]?.[row]?.status||'';
    sel.value=prev; sel.className="cam-status-sel"+(prev==="OK"?" s-ok":prev==="NOK"?" s-nok":prev==="PENDING"?" s-pend":"");
    return;
  }
  const val=sel.value;
  sel.className="cam-status-sel"+(val==="OK"?" s-ok":val==="NOK"?" s-nok":val==="PENDING"?" s-pend":"");
  const d=load(); if(!d[sk]) d[sk]={}; if(!d[sk][`cam${camNum}`]) d[sk][`cam${camNum}`]={};
  if(!d[sk][`cam${camNum}`][row]) d[sk][`cam${camNum}`][row]={};
  d[sk][`cam${camNum}`][row].status=val;

  const boxEl=document.querySelector(`#${cid}-row-${camNum}-${j} .cam-check-box`);
  const rowEl=document.getElementById(`${cid}-row-${camNum}-${j}`);
  if(val==="OK"){
    d[sk][`cam${camNum}`][row].checked=true;
    if(!d[sk][`cam${camNum}`][row].ts){ d[sk][`cam${camNum}`][row].ts=Date.now(); d[sk][`cam${camNum}`][row].user=getCurrentUser(); }
    if(boxEl) boxEl.classList.add("on"); if(rowEl) rowEl.classList.add("row-done");
  } else {
    d[sk][`cam${camNum}`][row].checked=false;
    d[sk][`cam${camNum}`][row].ts=null; d[sk][`cam${camNum}`][row].user=null;
    if(boxEl) boxEl.classList.remove("on"); if(rowEl) rowEl.classList.remove("row-done");
  }
  save(d, sk);
  const cd=d[sk][`cam${camNum}`]||{};
  const _rows2=getRows(sk,camNum);
  const n=_rows2.filter(r=>cd[r]?.checked).length;
  const pEl=document.getElementById(`${cid}-pct-${camNum}`); if(pEl) pEl.textContent=n+"/"+_rows2.length;
  const pillEl=document.getElementById(`${cid}-pills-${camNum}`); if(pillEl) pillEl.innerHTML=pillHtml(sk,camNum);
  checkCamComplete(sk, camNum, cid, d);
  refreshAll();
}

function camDone(sk, cams){
  const d=load(); if(!d[sk]) return 0;
  let n=0; cams.forEach(cam=>getRows(sk,cam.num).forEach(r=>{ if(d[sk][`cam${cam.num}`]?.[r]?.checked) n++; })); return n;
}

// ── CAM Checklist (Excel matrix) ─────────────────────────────────
function isChecked(v){ return typeof v === 'object' ? !!v?.v : !!v; }

function camCheckDone(sk, cams){
  const d=load(); if(!d[sk]) return 0;
  let n=0; cams.forEach(cam=>{ cam.checks.forEach(c=>{ if(isChecked(d[sk]?.[cam.id]?.[c])) n++; }); }); return n;
}

function getCamChecks(sk, camId){
  const map = {camck_pc:CAMCHECK_PC,camck_sl:CAMCHECK_SL,camck_sm:CAMCHECK_SM,camck_c14:CAMCHECK_CT14};
  const cam = (map[sk]||[]).find(c=>c.id===camId);
  return cam ? cam.checks : ALL_CAM_CHECKS;
}

function _updateChipUser(btn, user){
  btn.querySelector('.ccl-user')?.remove();
  btn.querySelector('.ccl-avatar')?.remove();
  if(!user) return;
  btn.insertAdjacentHTML('beforeend', userBadgeHTML(user));
}

const _camckFilter = {};
window.toggleCamFilter = function(cid){
  _camckFilter[cid] = !_camckFilter[cid];
  const container = document.getElementById(cid);
  if(container) container.classList.toggle('ccl-filter-on', !!_camckFilter[cid]);
  const btn = document.getElementById(cid+'-filter-btn');
  if(btn) btn.classList.toggle('active', !!_camckFilter[cid]);
};

function buildCamCheckPage(containerId, storageKey, cams){
  try{
  const container = document.getElementById(containerId);
  if(!container) return;
  const d = load();
  if(!d[storageKey]) d[storageKey] = {};

  // ── Incremental update: sync changed chips without destroying DOM ──
  if(container.querySelector('.cam-block')){
    cams.forEach(cam => {
      const safe = cam.id.replace(/\./g,'-');
      const block = document.getElementById(`${containerId}-block-${safe}`);
      if(!block) return;
      const camData = d[storageKey][cam.id] || {};
      const total = cam.checks.length;
      const checkedN = cam.checks.filter(c => isChecked(camData[c])).length;
      cam.checks.forEach(c => {
        const btn = block.querySelector(`button[data-check="${c}"]`);
        if(!btn) return;
        const val = camData[c];
        const on = isChecked(val);
        btn.classList.toggle('on', on);
        _updateChipUser(btn, on && val?.user ? val.user : null);
      });
      const pctEl = document.getElementById(`${containerId}-pct-${safe}`);
      if(pctEl) pctEl.textContent = `${checkedN}/${total}`;
      const isAllDone = checkedN === total;
      const hdr = block.querySelector('.cam-header');
      const wasAllDone = hdr?.classList.contains('cam-header-done');
      hdr?.classList.toggle('cam-header-done', isAllDone);
      block.dataset.done = isAllDone ? 'true' : 'false';
      if(isAllDone && !wasAllDone && !block.classList.contains('collapsed')){
        block.classList.add('collapsed');
        const body = block.querySelector('.cam-body');
        if(body) body.style.maxHeight = '0';
      }
    });
    return;
  }

  // ── Full build ──
  if(!document.getElementById(containerId+'-filter-btn')){
    const bar = document.createElement('div');
    bar.className = 'ccl-filter-bar';
    bar.innerHTML = `<button id="${containerId}-filter-btn" class="ccl-filter-btn${_camckFilter[containerId]?' active':''}" onclick="toggleCamFilter('${containerId}')">Toon alleen onvolledig</button>`;
    container.before(bar);
  }
  if(_camckFilter[containerId]) container.classList.add('ccl-filter-on');

  cams.forEach(cam => {
    const camData = d[storageKey][cam.id] || {};
    const total = cam.checks.length;
    const checkedN = cam.checks.filter(c => isChecked(camData[c])).length;
    const allDone = checkedN === total;
    const safe = cam.id.replace(/\./g,'-');
    const subInfo = [cam.type, cam.mcs ? 'MCS '+cam.mcs : ''].filter(Boolean).join(' · ');

    const groupsHTML = CAM_CHECK_GROUPS.map(g => {
      const applicable = g.checks.filter(c => cam.checks.includes(c));
      if(!applicable.length) return '';
      return `<div class="ccl-group"><span class="ccl-group-label">${g.label}</span><div class="ccl-chips">${
        applicable.map(c => {
          const val = camData[c];
          const on = isChecked(val);
          const user = on && val?.user ? val.user : '';
          const ck = c.replace(/'/g,"\\'");
          const lbl = /^[A-Z]+-(?:CAM|CCU)$/.test(c) ? c.split('-').slice(1).join('-') : c;
          return `<button class="ccl-chip${on?' on':''}" data-check="${c}" onclick="camCheckToggle('${storageKey}','${cam.id}','${ck}','${containerId}',this)">${lbl}${userBadgeHTML(user)}</button>`;
        }).join('')
      }</div></div>`;
    }).join('');

    const block = document.createElement('div');
    block.className = 'cam-block' + (allDone ? ' collapsed' : '');
    block.id = `${containerId}-block-${safe}`;
    block.dataset.done = allDone ? 'true' : 'false';
    block.innerHTML = `
      <div class="cam-header${allDone?' cam-header-done':''}" onclick="camCheckCollapse('${containerId}','${safe}')" style="touch-action:manipulation;">
        <span class="cam-badge">${cam.id}</span>
        <span class="cam-name"><span class="cam-sub">${subInfo}</span></span>
        <span class="cam-pct" id="${containerId}-pct-${safe}">${checkedN}/${total}</span>
        <span class="cam-arrow">&#9660;</span>
      </div>
      <div class="cam-body" style="max-height:${allDone?'0':'1200px'}">${groupsHTML}</div>`;
    container.appendChild(block);
  });
  } catch(e){ console.error('buildCamCheckPage error', e); }
}

function camCheckToggle(sk, camId, checkKey, cid, el){
  if(!_requireLogin()) return;
  const d = load();
  if(!d[sk]) d[sk] = {};
  if(!d[sk][camId]) d[sk][camId] = {};
  const isDone = !isChecked(d[sk][camId][checkKey]);
  const user = getCurrentUser();
  d[sk][camId][checkKey] = isDone ? {v:true, user, ts:Date.now()} : false;
  save(d, sk);
  el.classList.toggle('on', isDone);
  _updateChipUser(el, isDone ? user : null);

  const safe = camId.replace(/\./g,'-');
  const camData = d[sk][camId];
  const checks = getCamChecks(sk, camId);
  const checkedN = checks.filter(c => isChecked(camData[c])).length;
  const total = checks.length;
  const pctEl = document.getElementById(`${cid}-pct-${safe}`);
  if(pctEl) pctEl.textContent = `${checkedN}/${total}`;
  const block = document.getElementById(`${cid}-block-${safe}`);
  if(block){
    const hdr = block.querySelector('.cam-header');
    const wasAllDone = hdr?.classList.contains('cam-header-done');
    const isAllDone = checkedN === total;
    hdr?.classList.toggle('cam-header-done', isAllDone);
    if(isAllDone && !wasAllDone){
      hdr?.classList.add('cam-done-pop');
      setTimeout(()=>hdr?.classList.remove('cam-done-pop'), 700);
      setTimeout(()=>{
        if(!block.classList.contains('collapsed')){
          block.classList.add('collapsed');
          const body = block.querySelector('.cam-body');
          if(body) body.style.maxHeight = '0';
        }
      }, 800);
    }
    block.dataset.done = isAllDone ? 'true' : 'false';
  }
  el.classList.add('check-pop');
  setTimeout(()=>el.classList.remove('check-pop'),300);
  refreshAll();
}

function camCheckCollapse(cid, safe){
  const block = document.getElementById(`${cid}-block-${safe}`);
  if(!block) return;
  const body = block.querySelector('.cam-body');
  const collapsed = block.classList.toggle('collapsed');
  body.style.maxHeight = collapsed ? '0' : '1200px';
}

const POS_CHECKS = ["Monitors","Tablet","Audio","Netjes"];

function buildPosList(containerId, storageKey, positions){
  const container = document.getElementById(containerId);
  if(!container) return;
  const d = load();
  if(!d[storageKey]) d[storageKey] = {};
  container.innerHTML = "";

  positions.forEach(posObj => {
    const pos = typeof posObj === 'object' ? posObj.id : posObj;
    const posName = typeof posObj === 'object' ? posObj.name : posObj;
    const pd = d[storageKey][pos] || {};
    const doneN = POS_CHECKS.filter(c => pd[c]).length;
    const allDone = doneN === POS_CHECKS.length;
    const collapsed = allDone;

    const section = document.createElement("div");
    section.className = "pos-section" + (collapsed ? " collapsed" : "");
    section.id = `${containerId}-pos-${pos}`;

    const rowsHTML = POS_CHECKS.map((chk, j) => {
      const isDone = pd[chk] || false;
      const note = pd[chk+"_note"] || "";
      const posMeta = (isDone && (pd[chk+"_user"]||pd[chk+"_ts"])) ? esc(pd[chk+"_user"]||"")+(pd[chk+"_user"]&&pd[chk+"_ts"]?" · ":"")+fmtTime(pd[chk+"_ts"]||null) : "";
      return `<div class="pos-row${isDone ? " row-done" : ""}" id="${containerId}-posrow-${pos}-${j}">
        <div class="pos-row-left" onclick="posToggle('${storageKey}','${pos}',${j},'${containerId}',document.getElementById('${containerId}-posrow-${pos}-${j}'))">
          <div class="pos-check-box${isDone ? " on" : ""}${isDone&&note?" has-note":""}"><span class="ck">&#10003;</span></div>
          <div>
            <span class="pos-row-label">${chk}</span>
            ${posMeta ? `<span class="row-meta">${posMeta}</span>` : ""}
          </div>
        </div>
        <textarea class="pos-note-input" maxlength="500" placeholder="Notes…" oninput="posNote('${storageKey}','${pos}','${chk}',this)">${esc(note)}</textarea>
      </div>`;
    }).join("");

    section.innerHTML = `
      <div class="pos-header${allDone ? " pos-done" : ""}" onclick="posCollapse('${containerId}','${pos}')">
        <span class="pos-badge">${pos}</span>
        <span class="pos-title-wrap">
          <span class="pos-title">${posName}</span>
        </span>
        <span class="pos-pct" id="${containerId}-pospct-${pos}">${doneN}/${POS_CHECKS.length}</span>
        <span class="pos-arrow">&#9660;</span>
      </div>
      <div class="pos-body" style="max-height:${collapsed ? "0" : "1200px"}">
        ${rowsHTML}
      </div>`;
    container.appendChild(section);
  });
}

function posToggle(sk, pos, j, cid, rowEl){
  if(!_requireLogin()) return;
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
  save(d, sk);

  const posLabelEl = rowEl.querySelector('.pos-row-label')?.parentElement;
  if(posLabelEl){
    let posMetaEl = posLabelEl.querySelector('.row-meta');
    if(isDone){
      if(!posMetaEl){ posMetaEl = document.createElement('span'); posMetaEl.className='row-meta'; posLabelEl.appendChild(posMetaEl); }
      posMetaEl.textContent = (getCurrentUser()||"")+(getCurrentUser()?" · ":"")+fmtTime(Date.now());
    } else if(posMetaEl){ posMetaEl.textContent = ""; }
  }
  const hasNotePos = !!(d[sk]?.[pos]?.[chk+"_note"]);
  boxEl.classList.toggle("has-note", isDone && hasNotePos);
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
  save(d, sk);
  const box = ta.closest('.pos-row')?.querySelector('.pos-check-box');
  if(box) box.classList.toggle("has-note", box.classList.contains("on") && !!ta.value);
}

function posCollapse(cid, pos){
  const block = document.getElementById(`${cid}-pos-${pos}`);
  const body = block.querySelector(".pos-body");
  const now = block.classList.toggle("collapsed");
  body.style.maxHeight = now ? "0" : "1200px";
  const sk = cid.replace(/^list-/, "").replace(/-/g, "_");
  const d = load(); if(!d[sk]) d[sk]={}; if(!d[sk][pos]) d[sk][pos]={};
  d[sk][pos].collapsed = now; save(d);
}

function posDone(sk, positions){
  const d = load(); if(!d[sk]) return 0;
  let n = 0;
  positions.forEach(p => { const id = typeof p === 'object' ? p.id : p; POS_CHECKS.forEach(c => { if(d[sk][id]?.[c]) n++; }); });
  return n;
}

const PC4TH_POSITIONS = [
  {id:'403',name:'FRANCE TV DIGITAL'},{id:'404',name:'CHRTS-TV'},
  {id:'405',name:'TENNIS CHANNEL'},   {id:'406',name:'CHSRF-TV'},
  {id:'407',name:'PRIME'},            {id:'408',name:'FRANCE TV'},
  {id:'409',name:'CANAL+'},           {id:'410',name:'WBD/TNT'},
  {id:'411',name:'ESPN'},             {id:'412',name:'RTBF'},
  {id:'413',name:'CMG'},              {id:'414',name:'CHRSI-TV'},
];
const PC5TH_POSITIONS = [
  {id:'505',name:'SPIDER'},  {id:'506',name:'HB CT14'},
  {id:'507',name:'HB PC'},   {id:'508',name:'EUROSPORT'},
  {id:'512',name:'EUROSPORT'},
];
const COMMSL_POSITIONS = [
  {id:'305',name:'TENNIS CHANNEL'},{id:'306',name:'WBD/TNT'},
  {id:'307',name:'FRANCE TV'},     {id:'308',name:'HB SL'},
  {id:'309',name:'SPIDER'},
];
const COMMSM_POSITIONS = [
  {id:'TV1',name:'FRANCE TV'},{id:'TV2',name:'HB SM'},{id:'TV3',name:'WBD/TNT'},
];

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
        <div class="simple-check${isDone ? " on" : ""}${isDone&&note?" has-note":""}" onclick="simpleToggle('${storageKey}',${i},'${containerId}',this)"><span class="ck">&#10003;</span></div>
        <div class="simple-label-wrap" onclick="simpleToggle('${storageKey}',${i},'${containerId}',document.querySelector('#${containerId}-srow-${i} .simple-check'))">
          <span class="simple-label">${name}</span>
          <span class="row-meta" id="${containerId}-smeta-${i}">${sMeta}</span>
        </div>
        <textarea class="simple-note" maxlength="500" placeholder="Notes…" oninput="simpleNote('${storageKey}',${i},this)">${esc(note)}</textarea>
      </div>`;
    }).join("") +
  `</div>`;

}

function simpleToggle(sk, i, cid, boxEl){
  if(!_requireLogin()) return;
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
  save(d, sk);

  const metaEl = document.getElementById(`${cid}-smeta-${i}`);
  if(metaEl) metaEl.textContent = isDone ? (getCurrentUser()?getCurrentUser()+" · ":"")+fmtTime(Date.now()) : "";
  const hasNoteSim = !!(d[sk]?.[i]?.note);
  boxEl.classList.toggle("has-note", isDone && hasNoteSim);
  refreshAll();
}

function simpleNote(sk, i, ta){
  const d = load();
  if(!d[sk]) d[sk] = {};
  if(!d[sk][i]) d[sk][i] = {};
  d[sk][i].note = ta.value;
  save(d, sk);
  const box = ta.closest('.simple-row')?.querySelector('.simple-check');
  if(box) box.classList.toggle("has-note", box.classList.contains("on") && !!ta.value);
}

function camNote(sk, camNum, row, ta){
  const d=load(); if(!d[sk]) d[sk]={}; if(!d[sk][`cam${camNum}`]) d[sk][`cam${camNum}`]={};
  if(!d[sk][`cam${camNum}`][row]) d[sk][`cam${camNum}`][row]={};
  d[sk][`cam${camNum}`][row].note=ta.value; save(d, sk);
  const box = ta.closest('.cam-row')?.querySelector('.cam-check-box');
  if(box) box.classList.toggle("has-note", box.classList.contains("on") && !!ta.value);
  updateCamNoteDot(sk, camNum);
}
function updateCamNoteDot(sk, camNum){
  const d = load();
  const noteCount = getRows(sk, camNum).filter(r => !!(d[sk]?.[`cam${camNum}`]?.[r]?.note)).length;
  const dot = document.getElementById(`list-${sk.replace(/_/g,'-')}-notedot-${camNum}`);
  if(dot){
    dot.classList.toggle('has-note', noteCount > 0);
    dot.textContent = noteCount > 0 ? '📝 '+noteCount : '';
  }
}

function simpleDone(sk, total){
  const d = load();
  if(!d[sk]) return 0;
  let n = 0;
  for(let i = 0; i < total; i++){ if(d[sk][i]?.checked) n++; }
  return n;
}

const CAM_ROW_OVERRIDES = {
  "c14": { 1: ["FIBERS","SMPTE","CAMERA","MOUNT"], 5: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"], 6: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"], 7: ["CAMERA"] },
  "pc":  {
    1:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    3:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    4:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    5:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    7:  ["CAMERA"],
    9:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    10: ["FIBERS","SMPTE","CAMERA","MOUNT"],
    11: ["CAMERA"],
    12: ["FIBERS","CAMERA","MOUNT"],
    13: ["FIBERS","CAMERA","MOUNT"],
    14: ["FIBERS","SMPTE","CAMERA","MOUNT"],
    15: ["FIBERS","SMPTE","CAMERA","MOUNT"],
    16: ["FIBERS","CAMERA"],
    17: ["FIBERS","CAMERA"],
    18: ["FIBERS","CAMERA","MOUNT"],
    20: ["CAMERA"],
    21: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    22: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    24: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"]
  },
  "sl":  {
    1:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    5:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    6:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    7:  ["CAMERA"],
    8:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    9:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    10: ["FIBERS","SMPTE","CAMERA","MOUNT"],
    11: ["CAMERA"],
    12: ["FIBERS","CAMERA","MOUNT"],
    13: ["FIBERS","CAMERA","MOUNT"],
    14: ["FIBERS","SMPTE","CAMERA","MOUNT"],
    15: ["FIBERS","SMPTE","CAMERA","MOUNT"],
    16: ["FIBERS","CAMERA"],
    17: ["FIBERS","CAMERA"],
    18: ["FIBERS","CAMERA"],
    20: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"]
  },
  "sm":  {
    1:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    2:  ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
    7:  ["CAMERA"],
    8:  ["FIBERS","CAMERA","MOUNT"],
    9:  ["FIBERS","CAMERA","MOUNT"],
    10: ["FIBERS","CAMERA"],
    11: ["FIBERS","CAMERA"],
    13: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"]
  }
};
function getRows(sk, camNum){
  return (CAM_ROW_OVERRIDES[sk] && CAM_ROW_OVERRIDES[sk][camNum]) || CAM_ROWS;
}

const SECTIONS = [
  { key:"courts", listId:"list-courts", cams:null,
    total:()=>["pc","sl","sm","c14"].reduce((t,sk)=>t+(sk==="pc"?PC_CAMS:sk==="sl"?SL_CAMS:sk==="sm"?SM_CAMS:C14_CAMS).reduce((s,c)=>s+getRows(sk,c.num).length,0),0)
      +CAMCHECK_PC.reduce((s,c)=>s+c.checks.length,0)+CAMCHECK_SL.reduce((s,c)=>s+c.checks.length,0)+CAMCHECK_SM.reduce((s,c)=>s+c.checks.length,0)+CAMCHECK_CT14.reduce((s,c)=>s+c.checks.length,0),
    done:()=>camDone("pc",PC_CAMS)+camDone("sl",SL_CAMS)+camDone("sm",SM_CAMS)+camDone("c14",C14_CAMS)
      +camCheckDone("camck_pc",CAMCHECK_PC)+camCheckDone("camck_sl",CAMCHECK_SL)+camCheckDone("camck_sm",CAMCHECK_SM)+camCheckDone("camck_c14",CAMCHECK_CT14) },
  { key:"audio", listId:null, cams:null,
    total:()=>PC_MIC_ITEMS.length+SL_MIC_ITEMS.length+SM_MIC_ITEMS.length+C14_MIC_ITEMS.length+PC_SB_ITEMS.length+SL_SB_ITEMS.length+SM_SB_ITEMS.length+C14_SB_ITEMS.length,
    done:()=>simpleDone("audio_pc",PC_MIC_ITEMS.length)+simpleDone("audio_sl",SL_MIC_ITEMS.length)+simpleDone("audio_sm",SM_MIC_ITEMS.length)+simpleDone("audio_c14",C14_MIC_ITEMS.length)+simpleDone("sb_pc",PC_SB_ITEMS.length)+simpleDone("sb_sl",SL_SB_ITEMS.length)+simpleDone("sb_sm",SM_SB_ITEMS.length)+simpleDone("sb_c14",C14_SB_ITEMS.length) },
  { key:"comm",       listId:"list-comm",      cams:null,       total:()=>PC4TH_POSITIONS.length*POS_CHECKS.length+PC5TH_POSITIONS.length*POS_CHECKS.length+COMMSL_POSITIONS.length*POS_CHECKS.length+COMMSM_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_pc4th",PC4TH_POSITIONS)+posDone("comm_pc5th",PC5TH_POSITIONS)+posDone("comm_sl",COMMSL_POSITIONS)+posDone("comm_sm",COMMSM_POSITIONS) },
  { key:"gal",        listId:null,             cams:null,       total:()=>CCSR_ITEMS.length+CIR_ITEMS.length+MCR_ITEMS.length+INTERCOM_ITEMS.length+FFT_ITEMS.length+RF_CAMS_ITEMS.length+NOVA_105_ITEMS.length+SL_PRODUCTION_ITEMS.length+SL_AUDIO_ITEMS.length+SM_PRODUCTION_ITEMS.length+SM_AUDIO_ITEMS.length+EIC_AIC_ITEMS.length+EMG_OFFICE_ITEMS.length+EVS_SL_ITEMS.length+EVS_PC_ITEMS.length+QC_AUDIO_ITEMS.length+QC_PRODUCTION_ITEMS.length+GFX_ITEMS.length,
    done:()=>simpleDone("gal_CCSR",CCSR_ITEMS.length)+simpleDone("gal_CIR",CIR_ITEMS.length)+simpleDone("gal_MCR",MCR_ITEMS.length)+simpleDone("gal_INTERCOM",INTERCOM_ITEMS.length)+simpleDone("gal_FFT",FFT_ITEMS.length)+simpleDone("gal_RF_CAMS",RF_CAMS_ITEMS.length)+simpleDone("gal_NOVA_105",NOVA_105_ITEMS.length)+simpleDone("gal_SL_PRODUCTION",SL_PRODUCTION_ITEMS.length)+simpleDone("gal_SL_AUDIO",SL_AUDIO_ITEMS.length)+simpleDone("gal_SM_PRODUCTION",SM_PRODUCTION_ITEMS.length)+simpleDone("gal_SM_AUDIO",SM_AUDIO_ITEMS.length)+simpleDone("gal_EIC_AIC",EIC_AIC_ITEMS.length)+simpleDone("gal_EMG_OFFICE",EMG_OFFICE_ITEMS.length)+simpleDone("gal_EVS_SL",EVS_SL_ITEMS.length)+simpleDone("gal_EVS_PC",EVS_PC_ITEMS.length)+simpleDone("gal_QC_AUDIO",QC_AUDIO_ITEMS.length)+simpleDone("gal_QC_PRODUCTION",QC_PRODUCTION_ITEMS.length)+simpleDone("gal_GFX",GFX_ITEMS.length) },
  { key:"c14", listId:null, cams:C14_CAMS, total:()=>C14_CAMS.reduce((s,c)=>s+getRows("c14",c.num).length,0), done:()=>camDone("c14",C14_CAMS) },
  { key:"pc",  listId:null, cams:null,     total:()=>PC_CAMS.reduce((s,c)=>s+getRows("pc",c.num).length,0),   done:()=>camDone("pc",PC_CAMS) },
  { key:"sl",  listId:null, cams:null,     total:()=>SL_CAMS.reduce((s,c)=>s+getRows("sl",c.num).length,0),   done:()=>camDone("sl",SL_CAMS) },
  { key:"sm",  listId:null, cams:null,     total:()=>SM_CAMS.reduce((s,c)=>s+getRows("sm",c.num).length,0),   done:()=>camDone("sm",SM_CAMS) },
  { key:"comm_pc4th", listId:null, cams:null, total:()=>PC4TH_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_pc4th",PC4TH_POSITIONS) },
  { key:"comm_pc5th", listId:null, cams:null, total:()=>PC5TH_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_pc5th",PC5TH_POSITIONS) },
  { key:"comm_sl",    listId:null, cams:null, total:()=>COMMSL_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_sl",COMMSL_POSITIONS) },
  { key:"comm_sm",    listId:null, cams:null, total:()=>COMMSM_POSITIONS.length*POS_CHECKS.length, done:()=>posDone("comm_sm",COMMSM_POSITIONS) },
  { key:"camck_pc",   listId:null, cams:null, total:()=>CAMCHECK_PC.reduce((s,c)=>s+c.checks.length,0),   done:()=>camCheckDone("camck_pc",CAMCHECK_PC)   },
  { key:"camck_sl",   listId:null, cams:null, total:()=>CAMCHECK_SL.reduce((s,c)=>s+c.checks.length,0),   done:()=>camCheckDone("camck_sl",CAMCHECK_SL)   },
  { key:"camck_sm",   listId:null, cams:null, total:()=>CAMCHECK_SM.reduce((s,c)=>s+c.checks.length,0),   done:()=>camCheckDone("camck_sm",CAMCHECK_SM)   },
  { key:"camck_c14",  listId:null, cams:null, total:()=>CAMCHECK_CT14.reduce((s,c)=>s+c.checks.length,0), done:()=>camCheckDone("camck_c14",CAMCHECK_CT14) },
];

function pct(d,t){ return t?Math.round(d/t*100):0; }
function bar(id,p){ const el=document.getElementById(id); if(!el) return; if(el.style.width!==p+"%") el.style.width=p+"%"; el.classList.toggle('bar-full', p>=100); }
function txt(id,v){ const el=document.getElementById(id); if(el&&el.textContent!==String(v)) el.textContent=v; }
function chip(id,d,t){ const el=document.getElementById(id); if(!el) return; const v=d+"/"+t; if(el.textContent!==v) el.textContent=v; el.classList.toggle('done', t>0&&d===t); }


function triggerAvatarCelebration(){
  if(document.getElementById('av-celebration')) return;
  try{ sessionStorage.setItem('rg_seen_celebration','1'); }catch(e){}

  // Broadcast zodat verbonden teamleden het ook zien
  window._sendCelebrateBroadcast?.();

  // Sla op in Supabase zodat late arrivals het ook krijgen
  const _dCel = load();
  if(!_dCel._celebrationTs){
    _dCel._celebrationTs = Date.now();
    if(window.pushToSupabase) window.pushToSupabase(_dCel);
  }

  // Fanfare
  setTimeout(()=>window.playFanfare?.(), 300);

  unlockMiniGame();

  const overlay = document.createElement('div');
  overlay.id = 'av-celebration';
  document.body.appendChild(overlay);

  // ── Flash ────────────────────────────────────────────────────
  const flash = document.createElement('div');
  flash.className = 'av-flash';
  document.body.appendChild(flash);
  setTimeout(()=>flash.remove(), 2600);

  const users = getUsers();
  const PARTY_COLORS = ['#C9A84C','#fff','#e84040','#4fc3f7','#ff9800','#ab47bc','#66bb6a','#f06292','#ffee58','#ff5252','#69f0ae','#40c4ff'];

  function makeAvatarEl(name, cls){
    const av = getUserAvatar(name);
    const el = document.createElement('div');
    el.className = cls;
    if(av){
      const img = document.createElement('img');
      img.src = av; img.alt = name;
      el.appendChild(img);
    } else {
      el.classList.add('av-initials');
      el.style.background = `hsl(${(name.charCodeAt(0)*47)%360},60%,48%)`;
      el.textContent = name.substring(0,2).toUpperCase();
    }
    return el;
  }

  function makeBurst(count, delayMs, distMin, distMax, sizeMin, sizeMax){
    setTimeout(()=>{
      for(let i=0; i<count; i++){
        const angle = (i/count)*360 + Math.random()*10;
        const dist  = distMin + Math.random()*(distMax-distMin);
        const size  = sizeMin + Math.floor(Math.random()*(sizeMax-sizeMin));
        const name  = users[Math.floor(Math.random()*users.length)];
        const el    = makeAvatarEl(name, 'av-burst');
        el.style.cssText += `width:${size}px;height:${size}px;font-size:${Math.floor(size*.3)}px;left:50%;top:45%;`;
        el.style.setProperty('--bx', (Math.cos(angle*Math.PI/180)*dist)+'px');
        el.style.setProperty('--by', (Math.sin(angle*Math.PI/180)*dist)+'px');
        el.style.setProperty('--spin', (Math.random()>0.5?1:-1)*(180+Math.random()*400)+'deg');
        el.style.animationDelay = (Math.random()*0.18)+'s';
        el.style.animationDuration = (0.8+Math.random()*0.6)+'s';
        overlay.appendChild(el);
      }
    }, delayMs);
  }

  function launchFirework(x, y){
    if(!document.getElementById('av-celebration')) return;
    const color = PARTY_COLORS[Math.floor(Math.random()*PARTY_COLORS.length)];
    const rocket = document.createElement('div');
    rocket.className = 'av-rocket';
    rocket.style.cssText = `left:${x}px;top:${window.innerHeight+10}px;background:${color};box-shadow:0 0 10px 4px ${color};`;
    const dur = 0.55 + Math.random()*0.45;
    rocket.style.animationDuration = dur+'s';
    rocket.style.setProperty('--ry', -(window.innerHeight - y + 10)+'px');
    overlay.appendChild(rocket);
    setTimeout(()=>{
      if(rocket.parentNode) rocket.remove();
      if(!document.getElementById('av-celebration')) return;
      const count = 44 + Math.floor(Math.random()*28);
      for(let i=0; i<count; i++){
        const angle = (i/count)*360 + Math.random()*5;
        const dist  = 70 + Math.random()*160;
        const spark = document.createElement('div');
        spark.className = 'av-spark';
        spark.style.cssText = `left:${x}px;top:${y}px;background:${color};box-shadow:0 0 5px 3px ${color};`;
        spark.style.setProperty('--bx', Math.cos(angle*Math.PI/180)*dist+'px');
        spark.style.setProperty('--by', Math.sin(angle*Math.PI/180)*dist+'px');
        spark.style.setProperty('--spin', '0deg');
        const sparkDur = 0.5 + Math.random()*0.55;
        spark.style.animationDuration = sparkDur+'s';
        spark.style.animationDelay = (Math.random()*0.08)+'s';
        overlay.appendChild(spark);
        setTimeout(()=>{ if(spark.parentNode) spark.remove(); }, (sparkDur+0.2)*1000);
      }
    }, dur*1000);
  }

  // ── Banner 1: 100% ──────────────────────────────────────────
  const banner = document.createElement('div');
  banner.id = 'av-banner';
  banner.innerHTML = '<div class="av-banner-emoji">🎉</div><div class="av-banner-text">100%</div><div class="av-banner-sub">Alles afgevinkt!</div>';
  document.body.appendChild(banner);
  setTimeout(()=>{ banner.style.animation='avBannerFade .9s ease forwards'; setTimeout(()=>banner.remove(),900); }, 7000);

  // ── Banner 2: trofee ─────────────────────────────────────────
  setTimeout(()=>{
    if(!document.getElementById('av-celebration')) return;
    const b2 = document.createElement('div');
    b2.id = 'av-banner';
    b2.innerHTML = '<div class="av-banner-emoji">🏆</div><div class="av-banner-sub" style="font-size:clamp(24px,6vw,44px);color:#fff;font-weight:900;letter-spacing:.02em;">Geweldig gedaan!</div>';
    document.body.appendChild(b2);
    setTimeout(()=>{ b2.style.animation='avBannerFade .9s ease forwards'; setTimeout(()=>b2.remove(),900); }, 4500);
  }, 10000);

  // ── 5 burst golven ──────────────────────────────────────────
  makeBurst(68,     0, 130, 370, 52, 94);
  makeBurst(44,   700, 200, 450, 40, 78);
  makeBurst(36,  1600, 160, 330, 36, 68);
  makeBurst(28,  3200, 240, 470, 44, 76);
  makeBurst(22,  6000, 180, 420, 50, 86);

  // ── Confetti: 420 linten ─────────────────────────────────────
  for(let i=0; i<420; i++){
    const el = document.createElement('div');
    el.className = 'av-confetti';
    const w = 6 + Math.floor(Math.random()*13);
    const h = 11 + Math.floor(Math.random()*24);
    el.style.width  = w+'px';
    el.style.height = h+'px';
    el.style.background = PARTY_COLORS[Math.floor(Math.random()*PARTY_COLORS.length)];
    el.style.left = (Math.random()*112-6)+'%';
    el.style.top  = '-22px';
    el.style.animationDelay    = (Math.random()*30)+'s';
    el.style.animationDuration = (1.8+Math.random()*2.8)+'s';
    el.style.setProperty('--spin', (Math.random()>0.5?1:-1)*(200+Math.random()*620)+'deg');
    el.style.setProperty('--dx',   (Math.random()*280-140)+'px');
    overlay.appendChild(el);
  }

  // ── Avatar regen: 480 stuks ───────────────────────────────────
  for(let i=0; i<480; i++){
    const size  = 44 + Math.floor(Math.random()*72);
    const name  = users[Math.floor(Math.random()*users.length)];
    const el    = makeAvatarEl(name, 'av-piece');
    el.style.width  = size+'px';
    el.style.height = size+'px';
    el.style.fontSize = Math.floor(size*.3)+'px';
    el.style.left = (Math.random()*114-7)+'%';
    el.style.top  = '-130px';
    el.style.animationDelay    = (Math.random()*30)+'s';
    el.style.animationDuration = (2.4+Math.random()*3.4)+'s';
    el.style.setProperty('--spin', (Math.random()>0.5?1:-1)*(100+Math.random()*480)+'deg');
    el.style.setProperty('--dx',   (Math.random()*260-130)+'px');
    overlay.appendChild(el);
  }

  // ── Vuurwerk: ~50 raketten over 46 seconden ───────────────────
  let fwDelay = 400;
  while(fwDelay < 47000){
    ((d)=>{
      setTimeout(()=>{
        const x = 80 + Math.random()*(window.innerWidth-160);
        const y = 50 + Math.random()*(window.innerHeight*0.62);
        launchFirework(x, y);
      }, d);
    })(fwDelay);
    fwDelay += 700 + Math.random()*1100;
  }

  setTimeout(()=>{ if(overlay.parentNode) overlay.remove(); }, 52000);
}

let _rafPending = false;
function refreshAll(){
  if(_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(()=>{ _rafPending=false; _doRefresh(); });
}
window.refreshAll = refreshAll;
function _doRefresh(){
  try{
  refreshAudioCounters();

  const totals={}, dones={};
  SECTIONS.forEach(s=>{ totals[s.key]=s.total(); dones[s.key]=s.done(); });

  bar("courts-bar", pct(dones.courts,totals.courts)); txt("courts-lbl",dones.courts+"/"+totals.courts); txt("courts-count",dones.courts+"/"+totals.courts); txt("tab-camera-count",dones.courts+"/"+totals.courts); txt("sel-camera-count",dones.courts+"/"+totals.courts+" voltooid"); bar("sel-camera-bar", pct(dones.courts,totals.courts));

  bar("comm-bar",   pct(dones.comm,totals.comm));     txt("comm-lbl",dones.comm+"/"+totals.comm);       txt("comm-count",dones.comm+"/"+totals.comm);

  bar("gal-bar",    pct(dones.gal,totals.gal));       txt("gal-lbl",dones.gal+"/"+totals.gal);         txt("gal-count",dones.gal+"/"+totals.gal);
  const galMsg=document.getElementById("gal-done-msg"); if(galMsg) dones.gal===totals.gal&&totals.gal>0?galMsg.classList.add("visible"):galMsg.classList.remove("visible");

  ['CCSR', 'CIR', 'MCR', 'INTERCOM', 'FFT', 'RF-CAMS', 'NOVA-105', 'SL-PRODUCTION', 'SL-AUDIO', 'SM-PRODUCTION', 'SM-AUDIO', 'EIC-AIC', 'EMG-OFFICE', 'EVS-SL', 'EVS-PC', 'QC-AUDIO', 'QC-PRODUCTION', 'GFX'].forEach(key=>{
    const d=galItemDone(key), t=galItemTotal(key);
    txt("gal-note-"+key, d+" van "+t+" voltooid");
    chip("gal-pct-"+key, d, t);
  });

  bar("c14-bar",    pct(dones.c14,totals.c14));       txt("c14-lbl",dones.c14+"/"+totals.c14);         txt("count-c14",dones.c14+"/"+totals.c14);
  const c14Msg=document.getElementById("c14-done-msg"); if(c14Msg) dones.c14===totals.c14&&totals.c14>0?c14Msg.classList.add("visible"):c14Msg.classList.remove("visible");
  chip("chip-c14",dones.c14,totals.c14); txt("c14-note-label",dones.c14+" van "+totals.c14+" voltooid");

  bar("pc-bar",     pct(dones.pc,totals.pc));  txt("pc-lbl",dones.pc+"/"+totals.pc);   txt("count-pc",dones.pc+"/"+totals.pc);  chip("chip-pc",dones.pc,totals.pc);  txt("pc-note-label",dones.pc+" van "+totals.pc+" voltooid");
  bar("sl-bar",     pct(dones.sl,totals.sl));  txt("sl-lbl",dones.sl+"/"+totals.sl);   txt("count-sl",dones.sl+"/"+totals.sl);  chip("chip-sl",dones.sl,totals.sl);  txt("sl-note-label",dones.sl+" van "+totals.sl+" voltooid");
  bar("sm-bar",     pct(dones.sm,totals.sm));  txt("sm-lbl",dones.sm+"/"+totals.sm);   txt("count-sm",dones.sm+"/"+totals.sm);  chip("chip-sm",dones.sm,totals.sm);  txt("sm-note-label",dones.sm+" van "+totals.sm+" voltooid");

  // CAM Checklist nav badges
  bar("camck-pc-bar",  pct(dones.camck_pc, totals.camck_pc));  txt("camck-pc-lbl", dones.camck_pc+"/"+totals.camck_pc);   chip("chip-camck-pc", dones.camck_pc, totals.camck_pc);   txt("camck-pc-note",  dones.camck_pc+" van "+totals.camck_pc+" voltooid");
  bar("camck-sl-bar",  pct(dones.camck_sl, totals.camck_sl));  txt("camck-sl-lbl", dones.camck_sl+"/"+totals.camck_sl);   chip("chip-camck-sl", dones.camck_sl, totals.camck_sl);   txt("camck-sl-note",  dones.camck_sl+" van "+totals.camck_sl+" voltooid");
  bar("camck-sm-bar",  pct(dones.camck_sm, totals.camck_sm));  txt("camck-sm-lbl", dones.camck_sm+"/"+totals.camck_sm);   chip("chip-camck-sm", dones.camck_sm, totals.camck_sm);   txt("camck-sm-note",  dones.camck_sm+" van "+totals.camck_sm+" voltooid");
  bar("camck-c14-bar", pct(dones.camck_c14,totals.camck_c14)); txt("camck-c14-lbl",dones.camck_c14+"/"+totals.camck_c14); chip("chip-camck-c14",dones.camck_c14,totals.camck_c14);  txt("camck-c14-note", dones.camck_c14+" van "+totals.camck_c14+" voltooid");
  const camckTotal = (totals.camck_pc||0)+(totals.camck_sl||0)+(totals.camck_sm||0)+(totals.camck_c14||0);
  const camckDone  = (dones.camck_pc||0)+(dones.camck_sl||0)+(dones.camck_sm||0)+(dones.camck_c14||0);
  txt("camck-total-count", camckDone+"/"+camckTotal);

  [["pc4th"],["pc5th"],["sl"],["sm"]].forEach(([k])=>{
    const sk="comm_"+k, d=dones[sk]||0, t=totals[sk]||0, p=pct(d,t);
    bar(`comm-${k}-bar`,p); txt(`comm-${k}-lbl`,d+"/"+t); txt(`count-comm-${k}`,d+"/"+t);
    chip(`chip-comm-${k}`,d,t);
    txt(`comm-${k}-note`,d+" van "+t+" voltooid");
  });

  buildDash(totals, dones);

  // Feature 1: push notification als individuele court 100% bereikt
  const COURT_PUSH_LABELS = { pc:'Philippe-Chatrier', sl:'Suzanne-Lenglen', sm:'Simonne-Mathieu', c14:'Court 14' };
  if(!refreshAll._courtLastP) refreshAll._courtLastP = {};
  for(const [sk, label] of Object.entries(COURT_PUSH_LABELS)){
    const p = pct(dones[sk]||0, totals[sk]||0);
    const last = refreshAll._courtLastP[sk];
    if(last !== undefined && last < 100 && p >= 100 && (totals[sk]||0) > 0){
      showToast(`✓ ${label} — 100% klaar!`);
      _sendPushCourtDone(label, getCurrentUser());
    }
    refreshAll._courtLastP[sk] = p;
  }

  const TOP_KEYS = ["courts","audio","comm","gal"];
  const gT = TOP_KEYS.reduce((a,k)=>a+(totals[k]||0),0);
  const gD = TOP_KEYS.reduce((a,k)=>a+(dones[k]||0),0);
  const gP = pct(gD,gT);
  if(!window._dataReady && gT===0){
    bar("home-bar",0); txt("home-lbl",""); txt("home-done",""); txt("home-left",""); txt("home-pct","");
  } else {
    bar("home-bar",gP); txt("home-lbl",gD+" / "+gT);
    txt("home-done",gD); txt("home-left",gT-gD); txt("home-pct",gP+"%");
  }

  // Feature 2: countdown label als >90%
  const leftLabel = document.getElementById('home-left-label');
  const leftNum   = document.getElementById('home-left');
  if(leftLabel && gT > 0){
    if(gP >= 100){
      leftLabel.textContent = 'items over'; if(leftNum) leftNum.style.color = 'var(--green)';
    } else if(gP >= 90){
      leftLabel.textContent = 'items over 🔥'; if(leftNum) leftNum.style.color = 'var(--clay-dark)';
    } else if(gP >= 75){
      leftLabel.textContent = 'bijna klaar'; if(leftNum) leftNum.style.color = 'var(--clay)';
    } else {
      leftLabel.textContent = 'Resterend'; if(leftNum) leftNum.style.color = '';
    }
  }

  const hMsg=document.getElementById("home-done-msg"); if(hMsg) gD===gT&&gT>0?hMsg.classList.add("visible"):hMsg.classList.remove("visible");
  let _seenCel = false;
  try{ _seenCel = sessionStorage.getItem('rg_seen_celebration')==='1'; }catch(e){}
  if(!_seenCel){
    const _celTs = load()._celebrationTs || 0;
    const _celFresh = _celTs > 0 && (Date.now() - _celTs) < 24 * 60 * 60 * 1000; // max 1 dag
    const _justHit = gP>=100 && gT>0 && refreshAll._lastP !== undefined && refreshAll._lastP < 100;
    // Trigger als: zojuist 100% bereikt, OF 100% al bereikt + _celebrationTs recent (late arrival)
    if(_justHit || (_celFresh && gP>=100 && gT>0 && refreshAll._lastP===undefined)){
      const _wasUndef = refreshAll._lastP === undefined;
      setTimeout(triggerAvatarCelebration, _wasUndef ? 2000 : 0);
    }
  }
  refreshAll._lastP = gP;
  if(document.getElementById('page-problems')?.classList.contains('active')) buildProblems();
  } catch(e){ console.error('_doRefresh error', e); }
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
        <div class="dash-card-stamp" id="dc-stamp-${card.key}" style="display:none">✓ KLAAR</div>
        <div class="dash-card-icon">${card.icon}</div>
        <div class="dash-card-title">${card.label}</div>
        <div class="dash-card-track"><div class="dash-card-fill" id="dc-bar-${card.key}"></div></div>
        <div class="dash-card-footer">
          <span class="dash-card-count" id="dc-count-${card.key}"></span>
          <span class="dash-card-status" id="dc-status-${card.key}"></span>
          <span class="dash-card-pct" id="dc-pct-${card.key}"></span>
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
    div.style.background = p===100?"rgba(45,90,27,.05)":p>0&&p<50?"rgba(139,46,7,.06)":"var(--surface)";
    bar("dc-bar-"+card.key, p);
    const barEl = document.getElementById("dc-bar-"+card.key);
    if(barEl) barEl.style.background = p===100?"var(--green)":p>=50?"var(--clay)":"var(--clay-dark)";
    txt("dc-count-"+card.key, d+" / "+t);
    const pctEl = document.getElementById("dc-pct-"+card.key);
    if(pctEl){ pctEl.textContent=p+"%"; pctEl.style.color=color; }
    const statusEl = document.getElementById("dc-status-"+card.key);
    if(statusEl){
      statusEl.textContent = p===100?'✓ Klaar':p>0?'Bezig':'Niet gestart';
      statusEl.style.color = color;
      statusEl.style.background = p===100?"rgba(45,90,27,.12)":p>0?"rgba(193,68,14,.1)":"rgba(0,0,0,.05)";
    }
    const stampEl = document.getElementById("dc-stamp-"+card.key);
    if(stampEl) stampEl.style.display = p===100 ? 'block' : 'none';
  });
}

function exportToExcel(){
  closeAdminModal();
  if(window._loadXLSX){ window._loadXLSX(_doExportExcel); return; } _doExportExcel();
}
function _doExportToExcel(){  // bewaard als alias; verwijderd in volgende opruimronde
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
          cam.pos || "",
          row,
          rd.checked ? "✓" : "✗",
          rd.note || ""
        ]);
      });
    });
    const ws = makeWS(["CAM","Positie","Check","Status","Notitie"], rows, courtLabels[sk]);
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
    pos.forEach(posObj => {
      const p = typeof posObj === 'object' ? posObj.id : posObj;
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
    ["GFX",GFX_ITEMS,"gal_GFX"]
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

const DEFAULT_USERS = ["Jules","Robin","Aaron","Jarno","Rosan","Anne-Gert","Gaëlle","Pim","Remco","Peter","Emil","Damian","Lucas","Michiel"];

// Avatar-foto's per gebruiker — voeg hier namen + bestandsnamen toe
const USER_AVATARS = {
  "Pim":      "images/avatars/Pim.png",
  "Emil":     "images/avatars/Emil.png",
  "Jules":    "images/avatars/Jules.png",
  "Rosan":    "images/avatars/Rosan.png",
  "Aaron":    "images/avatars/Aaron.png",
  "Damian":   "images/avatars/Damian.png",
  "Lucas":    "images/avatars/Lucas.png",
  "Anne-Gert": "images/avatars/Anne-Gert.png",
  "Jarno":     "images/avatars/Jarno.png",
  "Peter":     "images/avatars/Peter.png",
  "Remco":     "images/avatars/Remco.png",
};
function getUserAvatar(name){
  if(!name) return null;
  try{ const d=load(); if(d._avatars?.[name]) return d._avatars[name]; }catch(e){}
  return USER_AVATARS[name] || null;
}
function userBadgeHTML(user){
  if(!user) return '';
  const av = getUserAvatar(user);
  return av ? `<img src="${av}" alt="${user}" title="${user}" class="ccl-avatar">`
             : `<span class="ccl-user">${user.substring(0,2).toUpperCase()}</span>`;
}

// Vul DEFAULT_USERS alleen in als er nog helemaal geen gebruikers zijn (eerste keer).
function seedDefaultUsers(){
  try {
    const d = load();
    if(!d._users || d._users.length === 0){
      saveUsers(DEFAULT_USERS);
    } else {
      // Eenmalige naamsmigraties
      const fixes = { "Anne-gert": "Anne-Gert" };
      let changed = false;
      const renamed = d._users.map(u => { if(fixes[u]){ changed=true; return fixes[u]; } return u; });
      // Dedupliceer (case-insensitive) — keep first occurrence
      const seen = new Set();
      const deduped = renamed.filter(u => { const k=u.toLowerCase(); if(seen.has(k)){changed=true;return false;} seen.add(k); return true; });
      if(changed) saveUsers(deduped);
    }
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
  const users = [...new Set(Object.values(state).flat().map(p=>p.user).filter(Boolean))];
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


function toggleAccessRequest(){
  const form = document.getElementById('access-req-form');
  if(!form) return;
  const open = form.style.display === 'flex';
  form.style.display = open ? 'none' : 'flex';
  if(!open) setTimeout(()=>document.getElementById('access-req-name')?.focus(), 50);
}

function submitAccessRequest(){
  const nameEl = document.getElementById('access-req-name');
  const name = nameEl?.value.trim();
  const fb = document.getElementById('access-req-feedback');
  const showFb = msg => { if(fb){ fb.textContent = msg; fb.style.display = 'block'; } };
  if(!name) return;
  const d = load();
  if((d._users||[]).includes(name)){
    showFb(`"${name}" bestaat al — selecteer je naam hierboven.`); return;
  }
  if((d._accessRequests||[]).find(r=>r.name===name && r.status==='pending')){
    showFb('Verzoek al verstuurd — een beheerder voegt je toe.'); return;
  }
  if(!d._accessRequests) d._accessRequests = [];
  d._accessRequests.push({ id: Date.now()+'_'+Math.random().toString(36).slice(2,6), name, ts: Date.now(), status:'pending' });
  save(d);
  document.getElementById('access-req-form').style.display = 'none';
  showFb('✓ Verzoek verstuurd — een beheerder voegt je toe.');
  updateAccessRequestBadge();
}

function approveRequest(id){
  const d = load();
  const req = (d._accessRequests||[]).find(r=>r.id===id);
  if(!req) return;
  req.status = 'approved';
  if(!d._users) d._users = [];
  if(!d._users.includes(req.name)){ d._users.push(req.name); d._usersTs = Date.now(); }
  save(d);
  renderAccessRequests();
  updateAccessRequestBadge();
  showToast(`✓ ${req.name} toegevoegd`);
}

function denyRequest(id){
  const d = load();
  if(!d._accessRequests) return;
  d._accessRequests = d._accessRequests.filter(r=>r.id!==id);
  save(d);
  renderAccessRequests();
  updateAccessRequestBadge();
}

function renderAccessRequests(){
  const section = document.getElementById('admin-requests-section');
  const list    = document.getElementById('admin-requests-list');
  const badge   = document.getElementById('admin-req-badge');
  if(!section||!list) return;
  const d = load();
  const pending = (d._accessRequests||[]).filter(r=>r.status==='pending');
  if(badge) badge.textContent = pending.length || '';
  section.style.display = pending.length ? 'block' : 'none';
  list.innerHTML = pending.map(r=>`
    <div class="admin-req-item">
      <span class="admin-req-name">${esc(r.name)}</span>
      <span class="admin-req-time">${fmtTime(r.ts)}</span>
      <div class="admin-req-actions">
        <button class="admin-req-approve" onclick="approveRequest('${r.id}')" style="touch-action:manipulation;">✓ Toevoegen</button>
        <button class="admin-req-deny"    onclick="denyRequest('${r.id}')"    style="touch-action:manipulation;">✕</button>
      </div>
    </div>`).join('');
}

function updateAccessRequestBadge(){
  const dot = document.getElementById('admin-req-dot');
  if(!dot) return;
  const count = (load()._accessRequests||[]).filter(r=>r.status==='pending').length;
  dot.textContent = count || '';
  dot.style.display = count > 0 ? 'block' : 'none';
}

function openAdminModal(){
  if(!ADMIN_USERS.includes(getCurrentUser())) return;
  const modal = document.getElementById("admin-modal");
  const loginSection = document.getElementById("admin-login-section");
  const panel = document.getElementById("admin-panel");
  const err = document.getElementById("admin-error");
  const input = document.getElementById("admin-pw-input");

  if(window._adminMode){
    if(loginSection) loginSection.style.display = "none";
    if(panel) panel.style.display = "block";
    renderAccessRequests();
  } else {
    if(loginSection) loginSection.style.display = "block";
    if(panel) panel.style.display = "none";
    if(err) err.style.display = "none";
    if(input) input.value = "";
    setTimeout(()=>{ if(input) input.focus(); }, 100);
  }
  modal.classList.add("open");

  if(!presenceChannel) initPresence();
  setTimeout(updateOnlineList, 300);
}

function closeAdminModal(e){
  if(e && e.target !== document.getElementById("admin-modal")) return;
  document.getElementById("admin-modal").classList.remove("open");
}

function openQuickProb(){
  const active = document.querySelector('.page.active');
  const badge    = active?.querySelector('.rg-badge')?.textContent?.trim() || '';
  const subTitle = active?.querySelector('.sub-title')?.textContent?.trim() || '';
  const location = [badge, subTitle].filter(Boolean).join(' — ') || 'Algemeen';
  document.getElementById('quick-prob-loc-text').textContent = location;
  document.getElementById('quick-prob-text').value = '';
  document.getElementById('quick-prob-urgent').checked = false;
  document.getElementById('quick-prob-modal').classList.add('open');
  setTimeout(()=>document.getElementById('quick-prob-text')?.focus(), 100);
}
function closeQuickProb(e){
  if(e && e.target !== document.getElementById('quick-prob-modal')) return;
  document.getElementById('quick-prob-modal').classList.remove('open');
}
function submitQuickProb(){
  const text = document.getElementById('quick-prob-text').value.trim();
  if(!text) return;
  const urgent   = document.getElementById('quick-prob-urgent').checked;
  const location = document.getElementById('quick-prob-loc-text').textContent;
  const d = load();
  if(!d._quickProblems) d._quickProblems = [];
  d._quickProblems.push({
    id: Date.now()+'_'+Math.random().toString(36).slice(2,6),
    text, urgent, location, user: getCurrentUser(), ts: Date.now(), resolved: false
  });
  save(d);
  document.getElementById('quick-prob-modal').classList.remove('open');
  if(document.getElementById('page-problems')?.classList.contains('active')) buildProblems();
}
function resolveQuickProb(id){
  const d = load();
  const prob = (d._quickProblems||[]).find(p=>p.id===id);
  if(prob){ prob.resolved=true; prob.resolvedTs=Date.now(); prob.resolvedBy=getCurrentUser(); }
  save(d);
  buildProblems();
}

function adminTogglePw(){
  const sec  = document.getElementById('admin-pw-section');
  const chev = document.getElementById('admin-pw-chev');
  if(!sec) return;
  const open = sec.style.display !== 'none';
  sec.style.display  = open ? 'none' : 'flex';
  if(chev) chev.textContent = open ? '▸' : '▾';
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

  if(!error && ADMIN_USERS.includes(getCurrentUser())){
    loginSection.style.display = "none";
    panel.style.display = "block";
    err.style.display = "none";
    window._adminMode = true;
    try{ sessionStorage.setItem('rg_admin','1'); }catch(e){}
  } else {
    err.style.display = "block";
    input.value = "";
    input.focus();
    input.style.borderColor = "var(--clay)";
    setTimeout(()=>{ input.style.borderColor = ""; }, 1000);
  }
}

async function changeAdminPassword(){
  if(!_isAdmin()) return;
  const cur  = document.getElementById('admin-pw-cur')?.value || '';
  const nw   = document.getElementById('admin-pw-new')?.value || '';
  const nw2  = document.getElementById('admin-pw-new2')?.value || '';
  if(!cur || !nw || !nw2){ showToast('⚠️ Vul alle velden in'); return; }
  if(nw !== nw2){ showToast('⚠️ Wachtwoorden komen niet overeen'); return; }
  if(nw.length < 6){ showToast('⚠️ Minimaal 6 tekens'); return; }
  if(!window._SUPABASE_URL){ showToast('⚠️ Geen verbinding'); return; }
  try{
    const tmp = supabase.createClient(window._SUPABASE_URL, window._SUPABASE_KEY);
    const { error: loginErr } = await tmp.auth.signInWithPassword({ email: ADMIN_AUTH_EMAIL, password: cur });
    if(loginErr){ showToast('⚠️ Huidig wachtwoord onjuist'); return; }
    const { error: updateErr } = await tmp.auth.updateUser({ password: nw });
    if(updateErr){ showToast('⚠️ Opslaan mislukt: ' + updateErr.message); return; }
    ['admin-pw-cur','admin-pw-new','admin-pw-new2'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    showToast('✓ Wachtwoord gewijzigd');
  } catch(e){ showToast('⚠️ Fout: ' + e.message); }
}

// Wijs alle items zonder gebruiker toe aan een naam
function _reassignAllUnknown(newUser){
  if(!_isAdmin()) return 0;
  if(!newUser) return 0;
  const d = load();
  let count = 0;
  // Cam rows
  ['pc','sl','sm','c14'].forEach(sk=>{
    if(!d[sk]) return;
    Object.values(d[sk]).forEach(camObj=>{
      Object.values(camObj).forEach(item=>{
        if(item && typeof item === 'object' && item.checked && !item.user){ item.user = newUser; count++; }
      });
    });
  });
  // Cam check chips
  ['camck_pc','camck_sl','camck_sm','camck_c14'].forEach(sk=>{
    if(!d[sk]) return;
    Object.values(d[sk]).forEach(camObj=>{
      if(typeof camObj !== 'object') return;
      Object.keys(camObj).forEach(chk=>{
        const v = camObj[chk];
        if(v && typeof v === 'object' && v.v && !v.user){ v.user = newUser; count++; }
      });
    });
  });
  // Comm positions
  ['comm_pc4th','comm_pc5th','comm_sl','comm_sm'].forEach(sk=>{
    if(!d[sk]) return;
    Object.values(d[sk]).forEach(posObj=>{
      if(typeof posObj !== 'object') return;
      POS_CHECKS.forEach(chk=>{
        if(posObj[chk] && !posObj[chk+'_user']){ posObj[chk+'_user'] = newUser; count++; }
      });
    });
  });
  // Simple items (gallery + audio)
  const simpleKeys = ['gal_CCSR','gal_CIR','gal_MCR','gal_INTERCOM','gal_FFT','gal_RF_CAMS','gal_NOVA_105','gal_SL_PRODUCTION','gal_SL_AUDIO','gal_SM_PRODUCTION','gal_SM_AUDIO','gal_EIC_AIC','gal_EMG_OFFICE','gal_EVS_SL','gal_EVS_PC','gal_QC_AUDIO','gal_QC_PRODUCTION','gal_GFX','audio_pc','audio_sl','audio_sm','audio_c14','sb_pc','sb_sl','sb_sm','sb_c14'];
  simpleKeys.forEach(sk=>{
    if(!d[sk]) return;
    Object.values(d[sk]).forEach(item=>{
      if(item && typeof item === 'object' && item.checked && !item.user){ item.user = newUser; count++; }
    });
  });
  if(count > 0){
    if(window._localSaveRaw) window._localSaveRaw(d);
    if(window.pushToSupabase) window.pushToSupabase(d);
  }
  return count;
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
    pos.forEach(posObj=>{ const p=typeof posObj==='object'?posObj.id:posObj; POS_CHECKS.forEach(chk=>{ const pd=(d[sk]||{})[p]||{}; if(pd[chk]&&pd[chk+'_ts']) events.push({ts:pd[chk+'_ts'],user:pd[chk+'_user']||'—',label:chk,section:`${lbl} · ${p}`}); }); });
  }

  // Gallery (alle 18 secties)
  const galMap = [
    {key:'gal_CCSR',items:CCSR_ITEMS,lbl:'🖼 CCSR'},
    {key:'gal_CIR',items:CIR_ITEMS,lbl:'🖼 CIR'},
    {key:'gal_MCR',items:MCR_ITEMS,lbl:'🖼 MCR'},
    {key:'gal_INTERCOM',items:INTERCOM_ITEMS,lbl:'🖼 Intercom'},
    {key:'gal_FFT',items:FFT_ITEMS,lbl:'🖼 FFT'},
    {key:'gal_RF_CAMS',items:RF_CAMS_ITEMS,lbl:'🖼 RF Cams'},
    {key:'gal_NOVA_105',items:NOVA_105_ITEMS,lbl:'🖼 Nova 105'},
    {key:'gal_SL_PRODUCTION',items:SL_PRODUCTION_ITEMS,lbl:'🖼 SL Production'},
    {key:'gal_SL_AUDIO',items:SL_AUDIO_ITEMS,lbl:'🖼 SL Audio'},
    {key:'gal_SM_PRODUCTION',items:SM_PRODUCTION_ITEMS,lbl:'🖼 SM Production'},
    {key:'gal_SM_AUDIO',items:SM_AUDIO_ITEMS,lbl:'🖼 SM Audio'},
    {key:'gal_EIC_AIC',items:EIC_AIC_ITEMS,lbl:'🖼 EIC/AIC'},
    {key:'gal_EMG_OFFICE',items:EMG_OFFICE_ITEMS,lbl:'🖼 EMG Office'},
    {key:'gal_EVS_SL',items:EVS_SL_ITEMS,lbl:'🖼 EVS SL'},
    {key:'gal_EVS_PC',items:EVS_PC_ITEMS,lbl:'🖼 EVS PC'},
    {key:'gal_QC_AUDIO',items:QC_AUDIO_ITEMS,lbl:'🖼 QC Audio'},
    {key:'gal_QC_PRODUCTION',items:QC_PRODUCTION_ITEMS,lbl:'🖼 QC Production'},
    {key:'gal_GFX',items:GFX_ITEMS,lbl:'🖼 GFX'},
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
    pos.forEach(posObj=>{
      const p=typeof posObj==='object'?posObj.id:posObj;
      POS_CHECKS.forEach(chk=>{
        const pd=(d[sk]||{})[p]||{};
        if(pd[chk]) addItem(pd[chk+"_user"], lbl+" "+p, chk, pd[chk+"_ts"]);
      });
    });
  }

  const galMap = [
    {key:'gal_CCSR',          items:CCSR_ITEMS,           lbl:'CCSR'},
    {key:'gal_CIR',           items:CIR_ITEMS,            lbl:'CIR'},
    {key:'gal_MCR',           items:MCR_ITEMS,            lbl:'MCR'},
    {key:'gal_INTERCOM',      items:INTERCOM_ITEMS,       lbl:'Intercom'},
    {key:'gal_FFT',           items:FFT_ITEMS,            lbl:'FFT'},
    {key:'gal_RF_CAMS',       items:RF_CAMS_ITEMS,        lbl:'RF Cams'},
    {key:'gal_NOVA_105',      items:NOVA_105_ITEMS,       lbl:'Nova 105'},
    {key:'gal_SL_PRODUCTION', items:SL_PRODUCTION_ITEMS,  lbl:'SL Production'},
    {key:'gal_SL_AUDIO',      items:SL_AUDIO_ITEMS,       lbl:'SL Audio'},
    {key:'gal_SM_PRODUCTION', items:SM_PRODUCTION_ITEMS,  lbl:'SM Production'},
    {key:'gal_SM_AUDIO',      items:SM_AUDIO_ITEMS,       lbl:'SM Audio'},
    {key:'gal_EIC_AIC',       items:EIC_AIC_ITEMS,        lbl:'EIC/AIC'},
    {key:'gal_EMG_OFFICE',    items:EMG_OFFICE_ITEMS,     lbl:'EMG Office'},
    {key:'gal_EVS_SL',        items:EVS_SL_ITEMS,         lbl:'EVS SL'},
    {key:'gal_EVS_PC',        items:EVS_PC_ITEMS,         lbl:'EVS PC'},
    {key:'gal_QC_AUDIO',      items:QC_AUDIO_ITEMS,       lbl:'QC Audio'},
    {key:'gal_QC_PRODUCTION', items:QC_PRODUCTION_ITEMS,  lbl:'QC Production'},
    {key:'gal_GFX',           items:GFX_ITEMS,            lbl:'GFX'},
  ];
  galMap.forEach(({key,items,lbl})=>{
    items.forEach((name,i)=>{
      const e=(d[key]||{})[i]||{};
      if(e.checked) addItem(e.user, lbl, name, e.ts);
    });
  });

  const audioMap=[
    {key:'audio_pc',items:PC_MIC_ITEMS,lbl:'Audio PC'},
    {key:'audio_sl',items:SL_MIC_ITEMS,lbl:'Audio SL'},
    {key:'audio_sm',items:SM_MIC_ITEMS,lbl:'Audio SM'},
    {key:'audio_c14',items:C14_MIC_ITEMS,lbl:'Audio C14'},
    {key:'sb_pc',items:PC_SB_ITEMS,lbl:'Stagebox PC'},
    {key:'sb_sl',items:SL_SB_ITEMS,lbl:'Stagebox SL'},
    {key:'sb_sm',items:SM_SB_ITEMS,lbl:'Stagebox SM'},
    {key:'sb_c14',items:C14_SB_ITEMS,lbl:'Stagebox C14'},
  ];
  audioMap.forEach(({key,items,lbl})=>{
    items.forEach((name,i)=>{
      const e=(d[key]||{})[i]||{};
      if(e.checked) addItem(e.user, lbl, name, e.ts);
    });
  });

  const camckMap=[
    {sk:'camck_pc',  cams:CAMCHECK_PC,   lbl:'Cam Check PC'},
    {sk:'camck_sl',  cams:CAMCHECK_SL,   lbl:'Cam Check SL'},
    {sk:'camck_sm',  cams:CAMCHECK_SM,   lbl:'Cam Check SM'},
    {sk:'camck_c14', cams:CAMCHECK_CT14, lbl:'Cam Check C14'},
  ];
  camckMap.forEach(({sk,cams,lbl})=>{
    cams.forEach(cam=>{
      cam.checks.forEach(chk=>{
        const e=(d[sk]||{})[cam.id]?.[chk];
        if(e && isChecked(e)) addItem(e.user, lbl+' '+cam.id, chk, e.ts);
      });
    });
  });

  if(Object.keys(persons).length===0){
    wrap.innerHTML='<p style="color:#aaa;font-size:12px;padding:20px 0;text-align:center;">Nog geen afgevinkte items gevonden.</p>';
    return;
  }

  const sorted = Object.entries(persons).sort((a,b)=>b[1].length-a[1].length);
  const total = sorted.reduce((s,[,items])=>s+items.length,0);

  const allUsers = getUsers();
  wrap.innerHTML = sorted.map(([name, items])=>{
    const pct = Math.round(items.length/total*100);
    const recentItems = [...items].sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,5);
    const isUnknown = name === 'Onbekend';
    const assignUI = (isUnknown && _isAdmin()) ? `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:10px;color:var(--clay);font-weight:600;">Toewijzen aan:</span>
        <select id="reassign-select" style="font-family:'DM Mono',monospace;font-size:11px;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;background:var(--surface);color:var(--ink);flex:1;">
          ${allUsers.map(u=>`<option value="${esc(u)}">${esc(u)}</option>`).join('')}
        </select>
        <button onclick="(function(){const u=document.getElementById('reassign-select')?.value;if(!u)return;const n=_reassignAllUnknown(u);buildPersons();showToast('✓ '+n+' items toegewezen aan '+u);})()" style="background:var(--green);color:#fff;border:none;font-family:'DM Mono',monospace;font-size:11px;padding:6px 12px;border-radius:6px;cursor:pointer;white-space:nowrap;touch-action:manipulation;">Wijs toe</button>
      </div>` : '';
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
      ${assignUI}
    </div>`;
  }).join('');
}

function buildProblems(){
  const d = load();
  const wrap = document.getElementById("problems-list");
  if(!wrap) return;

  // Snel gemelde problemen bovenaan
  const qpSection = document.getElementById('quick-prob-section');
  const qpList = document.getElementById('quick-prob-list');
  const qpCount = document.getElementById('quick-prob-count');
  const quickProbs = (d._quickProblems||[]).filter(p=>!p.resolved).sort((a,b)=>(b.urgent?1:0)-(a.urgent?1:0)||(b.ts||0)-(a.ts||0));
  if(qpList){
    if(quickProbs.length){
      if(qpSection) qpSection.style.display='';
      if(qpCount) qpCount.textContent=quickProbs.length;
      qpList.innerHTML=quickProbs.map(p=>`
        <div class="quick-prob-item${p.urgent?' quick-prob-urgent':''}">
          <div class="quick-prob-header">
            ${p.urgent?'<span class="od-urgent-badge">!! Urgent</span>':''}
            <span class="quick-prob-loc">📍 ${esc(p.location||'Algemeen')}</span>
            <span class="quick-prob-time">${fmtTime(p.ts)}</span>
          </div>
          <div class="quick-prob-text">${esc(p.text)}</div>
          <div class="quick-prob-meta">👤 ${esc(p.user||'—')} · <button class="quick-prob-resolve" onclick="resolveQuickProb('${p.id}')">✓ Opgelost</button></div>
        </div>`).join('');
    } else {
      if(qpSection) qpSection.style.display='none';
    }
  }

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
    pos.forEach(posObj=>{
      const p=typeof posObj==='object'?posObj.id:posObj;
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

  const galMap2 = [
    {key:'gal_CCSR',          items:CCSR_ITEMS,          lbl:'CCSR'},
    {key:'gal_CIR',           items:CIR_ITEMS,           lbl:'CIR'},
    {key:'gal_MCR',           items:MCR_ITEMS,           lbl:'MCR'},
    {key:'gal_INTERCOM',      items:INTERCOM_ITEMS,      lbl:'Intercom'},
    {key:'gal_FFT',           items:FFT_ITEMS,           lbl:'FFT'},
    {key:'gal_RF_CAMS',       items:RF_CAMS_ITEMS,       lbl:'RF Cams'},
    {key:'gal_NOVA_105',      items:NOVA_105_ITEMS,      lbl:'Nova 105'},
    {key:'gal_SL_PRODUCTION', items:SL_PRODUCTION_ITEMS, lbl:'SL Production'},
    {key:'gal_SL_AUDIO',      items:SL_AUDIO_ITEMS,      lbl:'SL Audio'},
    {key:'gal_SM_PRODUCTION', items:SM_PRODUCTION_ITEMS, lbl:'SM Production'},
    {key:'gal_SM_AUDIO',      items:SM_AUDIO_ITEMS,      lbl:'SM Audio'},
    {key:'gal_EIC_AIC',       items:EIC_AIC_ITEMS,       lbl:'EIC/AIC'},
    {key:'gal_EMG_OFFICE',    items:EMG_OFFICE_ITEMS,    lbl:'EMG Office'},
    {key:'gal_EVS_SL',        items:EVS_SL_ITEMS,        lbl:'EVS SL'},
    {key:'gal_EVS_PC',        items:EVS_PC_ITEMS,        lbl:'EVS PC'},
    {key:'gal_QC_AUDIO',      items:QC_AUDIO_ITEMS,      lbl:'QC Audio'},
    {key:'gal_QC_PRODUCTION', items:QC_PRODUCTION_ITEMS, lbl:'QC Production'},
    {key:'gal_GFX',           items:GFX_ITEMS,           lbl:'GFX'},
  ];
  galMap2.forEach(({key,items:list,lbl})=>{
    list.forEach((name,i)=>{
      const e=(d[key]||{})[i]||{};
      if(!e.checked || e.note){
        items.push({ section:lbl, label:name+(e.checked?' ✓':''), note:e.note||'', done:e.checked||false, user:e.user||'', ts:e.ts||null });
      }
    });
  });

  const openCount = items.filter(i=>!i.done).length;
  const noteCount = items.filter(i=>i.note).length;
  document.getElementById("problems-count").textContent = openCount+" open"+(noteCount?` · ${noteCount} notities`:'');

  if(items.length===0){
    wrap.innerHTML='<p style="color:#aaa;font-size:12px;padding:20px 0;text-align:center;">Geen openstaande items 🎾</p>';
    return;
  }

  // Items met notities bovenaan, daarna de rest
  const withNote    = items.filter(i=>i.note);
  const withoutNote = items.filter(i=>!i.note);
  const sorted = [...withNote, ...withoutNote];

  wrap.innerHTML = (withNote.length ? `<div style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--clay-dark);padding:8px 0 4px">📝 Met notitie (${withNote.length})</div>` : '')
    + sorted.map((item,idx)=>`
    ${idx===withNote.length && withNote.length>0 && withoutNote.length>0 ? `<div style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#aaa;padding:12px 0 4px">Overige open (${withoutNote.length})</div>` : ''}
    <div class="problem-item${item.note?' has-note':''}">
      <div class="problem-section">${esc(item.section)}</div>
      <div class="problem-label">${esc(item.label)}${item.done?'':' <span style="color:var(--clay);font-size:10px">● Open</span>'}</div>
      ${item.note?`<div class="problem-note">📝 ${esc(item.note)}</div>`:''}
      ${item.user||item.ts?`<div class="problem-note" style="color:#bbb">👤 ${esc(item.user||'—')} · ${fmtTime(item.ts)}</div>`:''}
    </div>`).join('');
}

function _doExportExcel(){
  if(typeof XLSX === "undefined"){ alert("Excel library niet geladen. Controleer je internetverbinding."); return; }
  const d = load();
  const wb = XLSX.utils.book_new();
  const now = new Date();
  const nowStr = now.toLocaleDateString("nl-NL");

  function fmtStatus(checked){ return checked ? "✓" : "—"; }
  function fmtUser(user){ return user||""; }
  function fmtTs(ts){ return ts ? new Date(ts).toLocaleString("nl-NL",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : ""; }

  // ── Cameras ──
  const courtMap = {c14:{cams:C14_CAMS,label:"C14"}, pc:{cams:PC_CAMS,label:"Philippe-Chatrier"}, sl:{cams:SL_CAMS,label:"Suzanne-Lenglen"}, sm:{cams:SM_CAMS,label:"Simonne-Mathieu"}};
  for(const [sk, {cams, label}] of Object.entries(courtMap)){
    const rows = [["CAM","Positie","Rij","Status","Door","Tijdstip","Notitie"]];
    cams.forEach(cam=>{
      const cd = (d[sk]||{})[`cam${cam.num}`]||{};
      getRows(sk, cam.num).forEach(row=>{
        const rd = cd[row]||{};
        rows.push([`CAM ${cam.num}`, cam.pos||"", row, fmtStatus(rd.checked), fmtUser(rd.user), fmtTs(rd.ts), rd.note||""]);
      });
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{wch:8},{wch:28},{wch:12},{wch:8},{wch:14},{wch:16},{wch:35}];
    XLSX.utils.book_append_sheet(wb, ws, label.substring(0,31));
  }

  // ── Commentaar ──
  const commRows = [["Box","Positie","Check","Status","Door","Tijdstip","Notitie"]];
  const commMap = {comm_pc4th:{pos:PC4TH_POSITIONS,lbl:"PC 4TH"}, comm_pc5th:{pos:PC5TH_POSITIONS,lbl:"PC 5TH"}, comm_sl:{pos:COMMSL_POSITIONS,lbl:"SL"}, comm_sm:{pos:COMMSM_POSITIONS,lbl:"SM"}};
  for(const [sk,{pos,lbl}] of Object.entries(commMap)){
    pos.forEach(posObj=>{
      const p=typeof posObj==='object'?posObj.id:posObj;
      const pd = (d[sk]||{})[p]||{};
      POS_CHECKS.forEach(chk=>{
        commRows.push([lbl, p, chk, fmtStatus(pd[chk]), fmtUser(pd[chk+"_user"]), fmtTs(pd[chk+"_ts"]), pd[chk+"_note"]||""]);
      });
    });
  }
  const wsComm = XLSX.utils.aoa_to_sheet(commRows);
  wsComm["!cols"] = [{wch:10},{wch:10},{wch:12},{wch:8},{wch:14},{wch:16},{wch:35}];
  XLSX.utils.book_append_sheet(wb, wsComm, "Commentaar");

  // ── Gallery (alle secties) ──
  const galRows = [["Gallery","Item","Status","Door","Tijdstip","Notitie"]];
  [
    ["CCSR",CCSR_ITEMS,"gal_CCSR"],["CIR",CIR_ITEMS,"gal_CIR"],["MCR",MCR_ITEMS,"gal_MCR"],
    ["INTERCOM",INTERCOM_ITEMS,"gal_INTERCOM"],["FFT",FFT_ITEMS,"gal_FFT"],
    ["RF-CAMS",RF_CAMS_ITEMS,"gal_RF_CAMS"],["NOVA-105",NOVA_105_ITEMS,"gal_NOVA_105"],
    ["SL-PRODUCTION",SL_PRODUCTION_ITEMS,"gal_SL_PRODUCTION"],["SL-AUDIO",SL_AUDIO_ITEMS,"gal_SL_AUDIO"],
    ["SM-PRODUCTION",SM_PRODUCTION_ITEMS,"gal_SM_PRODUCTION"],["SM-AUDIO",SM_AUDIO_ITEMS,"gal_SM_AUDIO"],
    ["EIC-AIC",EIC_AIC_ITEMS,"gal_EIC_AIC"],["EMG-OFFICE",EMG_OFFICE_ITEMS,"gal_EMG_OFFICE"],
    ["EVS-SL",EVS_SL_ITEMS,"gal_EVS_SL"],["EVS-PC",EVS_PC_ITEMS,"gal_EVS_PC"],
    ["QC-AUDIO",QC_AUDIO_ITEMS,"gal_QC_AUDIO"],["QC-PRODUCTION",QC_PRODUCTION_ITEMS,"gal_QC_PRODUCTION"],
    ["GFX",GFX_ITEMS,"gal_GFX"]
  ].forEach(([lbl,items,sk])=>{
    items.forEach((name,i)=>{
      const e=(d[sk]||{})[i]||{};
      galRows.push([lbl, name, fmtStatus(e.checked), fmtUser(e.user), fmtTs(e.ts), e.note||""]);
    });
  });
  const wsGal = XLSX.utils.aoa_to_sheet(galRows);
  wsGal["!cols"] = [{wch:14},{wch:28},{wch:8},{wch:14},{wch:16},{wch:35}];
  XLSX.utils.book_append_sheet(wb, wsGal, "Gallery's");

  // ── Audio ──
  const audioRows = [["Sectie","Item","Status","Door","Tijdstip","Notitie"]];
  [
    ["Audio PC · Mics",PC_MIC_ITEMS,"audio_pc"],["Audio SL · Mics",SL_MIC_ITEMS,"audio_sl"],
    ["Audio SM · Mics",SM_MIC_ITEMS,"audio_sm"],["Audio C14 · Mics",C14_MIC_ITEMS,"audio_c14"],
    ["Stageboxes PC",PC_SB_ITEMS,"sb_pc"],["Stageboxes SL",SL_SB_ITEMS,"sb_sl"],
    ["Stageboxes SM",SM_SB_ITEMS,"sb_sm"],["Stageboxes C14",C14_SB_ITEMS,"sb_c14"],
  ].forEach(([lbl,items,sk])=>{
    items.forEach((name,i)=>{
      const e=(d[sk]||{})[i]||{};
      audioRows.push([lbl, name, fmtStatus(e.checked), fmtUser(e.user), fmtTs(e.ts), e.note||""]);
    });
  });
  const wsAudio = XLSX.utils.aoa_to_sheet(audioRows);
  wsAudio["!cols"] = [{wch:20},{wch:40},{wch:8},{wch:14},{wch:16},{wch:35}];
  XLSX.utils.book_append_sheet(wb, wsAudio, "Audio");

  const camckMap = [
    {sk:"camck_pc",  cams:CAMCHECK_PC,   label:"CAM Check PC"},
    {sk:"camck_sl",  cams:CAMCHECK_SL,   label:"CAM Check SL"},
    {sk:"camck_sm",  cams:CAMCHECK_SM,   label:"CAM Check SM"},
    {sk:"camck_c14", cams:CAMCHECK_CT14, label:"CAM Check C14"},
  ];
  const camckRows = [["CAM","Type","MCS","Check","Status","Door","Tijdstip"]];
  camckMap.forEach(({sk,cams})=>{
    cams.forEach(cam=>{
      const cd = (d[sk]||{})[cam.id]||{};
      cam.checks.forEach(chk=>{
        const val = cd[chk];
        const checked = isChecked(val);
        camckRows.push([cam.id, cam.type, cam.mcs||"", chk, fmtStatus(checked),
          checked && val?.user ? fmtUser(val.user) : "",
          checked && val?.ts ? fmtTs(val.ts) : ""]);
      });
    });
  });
  const wsCamck = XLSX.utils.aoa_to_sheet(camckRows);
  wsCamck["!cols"] = [{wch:10},{wch:12},{wch:6},{wch:10},{wch:8},{wch:14},{wch:16}];
  XLSX.utils.book_append_sheet(wb, wsCamck, "CAM Checklist");

  const filename = `RG2026_Status_${nowStr.replace(/\//g,"-")}.xlsx`;
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
  saveBackup(d, 'Volledige reset');
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
  if(!_isAdmin()) return;
  _adminResetKeys = keys;
  document.getElementById('admin-reset-label').textContent = label;
  document.getElementById('admin-reset-confirm').style.display = 'block';
  _showExistingBackup_slots();
}
function adminResetCancel(){
  _adminResetKeys = [];
  document.getElementById('admin-reset-confirm').style.display = 'none';
}
function adminResetConfirm(){
  if(!_isAdmin()) return;
  const d = load();
  // Backup opslaan vóór reset
  saveBackup(d, 'Reset: ' + document.getElementById('admin-reset-label').textContent);
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

const BACKUP_KEY = 'rg_backups';
const BACKUP_MAX = 3;

function saveBackup(data, label){
  if(!_isAdmin()) return;
  try{
    const raw = localStorage.getItem(BACKUP_KEY);
    const slots = raw ? JSON.parse(raw) : [];
    let overwriteMsg = null;
    if(slots.length >= BACKUP_MAX){
      const oldest = slots[slots.length - 1];
      overwriteMsg = `Oudste backup overschreven (${esc(oldest.label)} · ${fmtTime(oldest.ts)})`;
    }
    slots.unshift({ data, label, ts: Date.now() });
    if(slots.length > BACKUP_MAX) slots.length = BACKUP_MAX;
    localStorage.setItem(BACKUP_KEY, JSON.stringify(slots));
    _renderBackupSlots(slots);
    if(overwriteMsg) showToast('⚠️ ' + overwriteMsg);
    else showToast(`Backup opgeslagen (${slots.length}/${BACKUP_MAX})`);
  } catch(e){}
  // Mirror to Supabase (best-effort, non-blocking)
  try{
    const sc = window._supaClient;
    if(sc) sc.from('checklist_backups').insert({ label, ts: Date.now(), payload: data }).then(()=>{}).catch(()=>{});
  } catch(e){}
}

function _renderBackupSlots(slots){
  const wrap = document.getElementById('admin-restore-wrap');
  if(!wrap) return;
  if(!slots || slots.length === 0){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const nextWillOverwrite = slots.length >= BACKUP_MAX;
  wrap.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <span style="font-size:10px;font-weight:700;letter-spacing:.05em;opacity:.6;">BACKUPS</span>
      <span style="font-size:10px;color:${nextWillOverwrite?'var(--clay)':'var(--green)'};">${slots.length}/${BACKUP_MAX}${nextWillOverwrite?' · volgende overschrijft oudste':''}</span>
    </div>` +
    slots.map((s, i) =>
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:${i<slots.length-1?'6px':'0'}">
        <span style="flex:1;font-size:10px;color:var(--green);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${esc(s.label)} · ${fmtTime(s.ts)}</span>
        <button onclick="adminRestoreBackup(${i})" style="background:var(--green);color:#fff;border:none;font-family:'DM Mono',monospace;font-size:10px;padding:5px 10px;border-radius:6px;cursor:pointer;touch-action:manipulation;white-space:nowrap;">↩ Herstel</button>
      </div>`
    ).join('');
}

function _showExistingBackup_slots(){
  try{
    const raw = localStorage.getItem(BACKUP_KEY);
    if(!raw) return;
    _renderBackupSlots(JSON.parse(raw));
  } catch(e){}
}

function adminRestoreBackup(idx){
  if(!_isAdmin()) return;
  try{
    idx = idx || 0;
    const raw = localStorage.getItem(BACKUP_KEY);
    if(!raw) return;
    const slots = JSON.parse(raw);
    const slot = slots[idx];
    if(!slot || !slot.data) return;
    // Custom confirm — native confirm() is blocked in some PWA/iOS standalone contexts
    const wrap = document.getElementById('admin-restore-wrap');
    if(!wrap) return;
    const existing = wrap.querySelector('.restore-confirm');
    if(existing) existing.remove();
    const conf = document.createElement('div');
    conf.className = 'restore-confirm';
    conf.style.cssText = 'margin-top:10px;background:rgba(193,68,14,.08);border:1.5px solid var(--clay);border-radius:8px;padding:10px 12px;font-size:11px;';
    conf.innerHTML = `<div style="margin-bottom:8px;color:var(--clay-dark);font-weight:600;">⚠️ "${esc(slot.label)}" terugzetten?<br><span style="font-weight:400;color:#888;">Huidige staat wordt overschreven.</span></div>
      <div style="display:flex;gap:8px;">
        <button onclick="(function(){var s=JSON.parse(localStorage.getItem('${BACKUP_KEY}')||'[]');var sl=s[${idx}];if(sl&&sl.data){_localSaveRaw(sl.data);if(window.pushToSupabase)window.pushToSupabase(sl.data);buildAllLists();refreshAll();showToast('Backup teruggezet.');}document.querySelector('.restore-confirm')?.remove();})()" style="flex:1;padding:8px;background:var(--clay-dark);color:white;border:none;border-radius:6px;font-family:'DM Mono',monospace;font-size:10px;cursor:pointer;touch-action:manipulation;">Ja, terugzetten</button>
        <button onclick="this.closest('.restore-confirm').remove()" style="padding:8px 12px;background:none;border:1.5px solid var(--border);color:var(--ink);border-radius:6px;font-family:'DM Mono',monospace;font-size:10px;cursor:pointer;touch-action:manipulation;">Annuleer</button>
      </div>`;
    wrap.appendChild(conf);
  } catch(e){ showToast('Backup terugzetten mislukt.'); }
}

function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

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

function _makeTodoInputRow(val, urgent){
  const row = document.createElement('div');
  row.className = 'od-todo-row';
  row.dataset.urgent = urgent ? '1' : '0';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'od-todo-input';
  input.placeholder = 'To do punt…';
  input.maxLength = 200;
  input.value = val || '';
  input.addEventListener('input', ()=>{ if(window._odConceptSave) window._odConceptSave(); });
  input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); addOdTodoInput(false); } });
  const urgBtn = document.createElement('button');
  urgBtn.className = 'od-todo-urg' + (urgent ? ' on' : '');
  urgBtn.type = 'button';
  urgBtn.title = 'Markeer als urgent';
  urgBtn.textContent = '!!';
  urgBtn.setAttribute('style','touch-action:manipulation');
  urgBtn.onclick = ()=>{
    const on = row.dataset.urgent === '1';
    row.dataset.urgent = on ? '0' : '1';
    urgBtn.classList.toggle('on', !on);
    if(window._odConceptSave) window._odConceptSave();
  };
  const del = document.createElement('button');
  del.className = 'od-todo-del';
  del.type = 'button';
  del.textContent = '✕';
  del.setAttribute('style','touch-action:manipulation');
  del.onclick = ()=>{ row.remove(); if(window._odConceptSave) window._odConceptSave(); };
  row.appendChild(input);
  row.appendChild(urgBtn);
  row.appendChild(del);
  return row;
}

function addOdTodoInput(isEdit){
  const builder = document.getElementById(isEdit ? 'od-edit-todo-builder' : 'od-todo-builder');
  if(!builder) return;
  const row = _makeTodoInputRow('');
  builder.appendChild(row);
  row.querySelector('input')?.focus();
}

function _getOdTodoItems(builderId){
  const builder = document.getElementById(builderId);
  if(!builder) return [];
  return Array.from(builder.querySelectorAll('.od-todo-row'))
    .map(row => {
      const text = row.querySelector('input.od-todo-input')?.value.trim() || '';
      const urgent = row.dataset.urgent === '1';
      return text ? {text, done: false, urgent} : null;
    }).filter(Boolean);
}

function toggleOdTodo(entryId, idx){
  if(!_requireLogin()) return;
  const d = load();
  const entry = (d._overdrachten||[]).find(e=>e.id===entryId);
  if(!entry || !Array.isArray(entry.todo) || !entry.todo[idx]) return;
  const item = entry.todo[idx];
  item.done = !item.done;
  if(item.done){ item.doneBy = getCurrentUser(); item.doneTs = Date.now(); }
  else { delete item.doneBy; delete item.doneTs; }
  entry.editedTs = Date.now();
  save(d);
  if(window.pushToSupabase) window.pushToSupabase(d);
  const row = document.getElementById(`od-td-${entryId}-${idx}`);
  if(row){
    row.classList.toggle('od-todo-done', item.done);
    row.classList.toggle('od-todo-urgent', item.urgent && !item.done);
    row.querySelector('.od-todo-check-box')?.classList.toggle('on', item.done);
    const badge = row.querySelector('.od-todo-urgent-badge');
    if(badge) badge.style.display = item.urgent && !item.done ? '' : 'none';
    const meta = row.querySelector('.od-todo-check-meta');
    if(meta) meta.textContent = item.done ? `${item.doneBy||''}${item.doneBy?' · ':''}${fmtTime(item.doneTs)}` : '';
  }
  _checkOdTodosCollapse(entryId);
  renderOdOpenItems();
  if(navigator.vibrate) navigator.vibrate(15);
}

function _fmtPhaseDate(str){
  return new Date(str+'T12:00:00').toLocaleDateString('nl-NL',{day:'numeric',month:'short'});
}

function renderOdPhaseStrip(){
  const el = document.getElementById('od-phase-strip');
  if(!el) return;
  const phases = [
    { name:'Rig',        start:'2026-04-27', end:'2026-05-17' },
    { name:'Qualifiers', start:'2026-05-18', end:'2026-05-23' },
    { name:'Tournament', start:'2026-05-24', end:'2026-06-07' },
  ];
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  el.innerHTML = '<div class="od-phase-strip-inner">' + phases.map(p => {
    const start = new Date(p.start+'T00:00:00');
    const end   = new Date(p.end+'T23:59:59');
    const totalDays = Math.round((end - start) / 86400000) + 1;
    let state, sub, dayNum = 0, barHtml = '';
    if(todayStr > p.end){
      state = 'past'; sub = '✓ Afgerond';
    } else if(todayStr >= p.start){
      state = 'current';
      dayNum = Math.floor((now - start) / 86400000) + 1;
      sub = `Dag ${dayNum} / ${totalDays}`;
      const pct = Math.min(100, ((dayNum - 1) / totalDays * 100)).toFixed(1);
      barHtml = `<div class="od-phase-bar"><div class="od-phase-bar-fill" style="width:${pct}%"></div></div>`;
    } else {
      state = 'future';
      const daysUntil = Math.ceil((start - now) / 86400000);
      sub = daysUntil === 1 ? 'Morgen' : `Over ${daysUntil} d`;
    }
    return `<div class="od-phase-tile od-phase-${state}">
      <div class="od-phase-name">${p.name}</div>
      <div class="od-phase-dates">${_fmtPhaseDate(p.start)} – ${_fmtPhaseDate(p.end)}</div>
      <div class="od-phase-sub">${sub}</div>
      ${barHtml}
    </div>`;
  }).join('') + '</div>';
}

function buildOverdracht(){
  try{
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
  if(verslagEl && concept.verslag) verslagEl.value = concept.verslag;
  if(dateEl && concept.date) dateEl.value = concept.date;
  const shiftEl = document.getElementById('od-shift');
  if(shiftEl && concept.shift) shiftEl.value = concept.shift;

  // Build todo list from concept
  const builder = document.getElementById('od-todo-builder');
  if(builder){
    builder.innerHTML = '';
    const items = Array.isArray(concept.todo) ? concept.todo : [];
    items.forEach(item => builder.appendChild(_makeTodoInputRow(item.text || item, item.urgent)));
    if(items.length === 0) builder.appendChild(_makeTodoInputRow(''));
  }

  // Auto-save concept on input
  window._odConceptSave = () => {
    try{
      localStorage.setItem('rg_od_concept', JSON.stringify({
        verslag: verslagEl?.value || '',
        todo:    _getOdTodoItems('od-todo-builder'),
        date:    dateEl?.value    || '',
        shift:   shiftEl?.value   || '',
      }));
    } catch(e){}
  };
  verslagEl?.addEventListener('input', window._odConceptSave);
  dateEl   ?.addEventListener('change', window._odConceptSave);
  shiftEl  ?.addEventListener('change', window._odConceptSave);

  renderOdPhaseStrip();
  renderOdLog();
  } catch(e){ console.error('buildOverdracht error', e); }
}

function saveOverdracht(){
  const name    = document.getElementById('od-name')?.value;
  const date    = document.getElementById('od-date')?.value;
  const shift   = document.getElementById('od-shift')?.value;
  const verslag = document.getElementById('od-verslag')?.value.trim();
  const todo    = _getOdTodoItems('od-todo-builder');
  if(!verslag && todo.length === 0){ showOdToast('Vul minimaal één veld in', 'error'); return; }
  if(!date){ showOdToast('Vul een datum in', 'error'); return; }
  if(!shift){ showOdToast('Kies een shift (Ochtend of Avond)', 'error'); return; }

  const d = load();
  if(!d._overdrachten) d._overdrachten = [];
  d._overdrachten.push({ id: Date.now(), name, date, shift, verslag, todo, ts: Date.now(), user: getCurrentUser() });
  save(d);
  if(window.pushToSupabase) window.pushToSupabase(d);

  // Clear form + concept
  document.getElementById('od-verslag').value = '';
  odWordCount('od-verslag','od-verslag-wc');
  const builder = document.getElementById('od-todo-builder');
  if(builder){ builder.innerHTML = ''; builder.appendChild(_makeTodoInputRow('')); }
  localStorage.removeItem('rg_od_concept');

  if(navigator.vibrate) navigator.vibrate([20, 30, 20]);
  showOdToast('✅ Overdracht opgeslagen!', 'success');
  _sendPushOverdracht(getCurrentUser(), shift || 'nieuwe');
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
    renderOdOpenItems();
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
  const _fourDaysAgo = new Date(); _fourDaysAgo.setDate(_fourDaysAgo.getDate() - 4);
  const fourDaysAgoStr = _fourDaysAgo.toISOString().split('T')[0];
  renderOdOpenItems();
  const sortedDates = Object.keys(groups).sort((a,b)=>b.localeCompare(a));
  wrap.innerHTML = sortedDates.map((date, idx) => {
    const items = groups[date];
    const isToday = date === today;
    const gid = 'odg-' + date;
    const autoCollapse = date < fourDaysAgoStr && items.every(e => {
      const tl = Array.isArray(e.todo) ? e.todo : [];
      return tl.length > 0 && tl.every(t => t.done);
    });
    const d2 = new Date(date + 'T12:00:00');
    const dateLabel = d2.toLocaleDateString('nl-NL',{weekday:'long',day:'numeric',month:'long'});
    const col = OD_COLORS[idx % OD_COLORS.length];

    const itemsHtml = items.map(e => {
      const todoItems  = Array.isArray(e.todo) ? e.todo : [];
      const urgentOpen = todoItems.filter(t => t.urgent && !t.done).length;
      const openCount  = todoItems.filter(t => !t.done).length;
      const allDone    = todoItems.length > 0 && todoItems.every(t => t.done);
      const todoHtml = (()=>{
        if(!e.todo) return '';
        if(typeof e.todo === 'string') return e.todo ? `<div class="od-section"><div class="od-section-label">📌 To do volgende ploeg</div><div class="od-section-text">${esc(e.todo)}</div></div>` : '';
        if(!todoItems.length) return '';
        const checks = todoItems.map((item,i)=>`<div class="od-todo-check${item.done?' od-todo-done':''}${item.urgent&&!item.done?' od-todo-urgent':''}" id="od-td-${e.id}-${i}" onclick="toggleOdTodo(${e.id},${i})" style="touch-action:manipulation;"><div class="od-todo-check-box${item.done?' on':''}"><span class="ck">✓</span></div><div class="od-todo-check-right">${item.urgent&&!item.done?'<span class="od-todo-urgent-badge">!!</span>':''}<span class="od-todo-check-text">${esc(item.text)}</span><span class="od-todo-check-meta">${item.done&&item.doneTs?`${esc(item.doneBy||'')}${item.doneBy?' · ':''}${fmtTime(item.doneTs)}`:''}</span></div></div>`).join('');
        if(allDone) return `<div class="od-section"><div id="od-todos-label-${e.id}" class="od-section-label od-todos-done-label" onclick="odExpandTodos(${e.id})" style="cursor:pointer;display:flex;align-items:center;gap:6px;"><span style="color:var(--green);">✓</span> ${todoItems.length} actie${todoItems.length>1?'s':''} afgerond <span id="od-todos-chev-${e.id}" style="font-size:9px;color:#aaa;margin-left:auto;">▸</span></div><div id="od-todos-${e.id}" style="display:none;"><div class="od-todo-checks" style="margin-top:6px;">${checks}</div></div></div>`;
        return `<div class="od-section"><div id="od-todos-label-${e.id}" class="od-section-label">📌 To do</div><div id="od-todos-${e.id}"><div class="od-todo-checks">${checks}</div></div></div>`;
      })();
      const av = getUserAvatar(e.name||'');
      const avatarHtml = av ? `<img src="${av}" class="od-item-avatar" alt="${esc(e.name||'')}">` : '';
      const timeLabel = e.ts ? fmtTime(e.ts) : '';
      return `
      <div class="od-item"${urgentOpen>0?' style="border-left:3px solid var(--clay);"':''}>
        <div class="od-item-header">
          <div class="od-item-name">
            <span class="od-shift-badge od-shift-${e.shift||'ochtend'}">${e.shift==='avond'?'🌙':'🌅'} ${e.shift||'ochtend'}</span>
            ${avatarHtml}
            ${esc(e.name||'')}
          </div>
          ${urgentOpen>0?`<span class="od-urgent-badge">!! ${urgentOpen}</span>`:''}
          ${timeLabel?`<span class="od-item-meta">${timeLabel}</span>`:''}
        </div>
        <div class="od-sections-grid">
          ${e.verslag?`<div class="od-section"><div class="od-section-label">📋 Dagverslag</div><div class="od-section-text">${esc(e.verslag)}</div></div>`:''}
          ${todoHtml}
        </div>
        ${((e.user||e.name)===getCurrentUser() || _isAdmin()) ? `
        <div class="od-item-actions">
          <button class="od-action-btn" onclick="openOdEdit(${e.id})" style="touch-action:manipulation;">✏️ Aanpassen</button>
          <button class="od-action-btn delete" onclick="deleteOverdracht(${e.id})" style="touch-action:manipulation;">🗑 Verwijderen</button>
        </div>` : ''}
      </div>`;
    }).join('');

    return `<div class="section" style="padding:0;background:none;border:none;box-shadow:none;margin-bottom:8px;">
      <div class="od-day-header" onclick="odToggle('${gid}')" style="background:${col.bg};border-color:${col.border};color:${col.text}">
        <span class="od-day-label">${dateLabel}${isToday?' <span class="od-today">vandaag</span>':''}</span>
        <span class="od-day-count">${items.length} overdracht${items.length>1?'en':''}</span>
        <span class="od-day-chev" id="chev-${gid}">${autoCollapse?'▸':'▾'}</span>
      </div>
      <div id="${gid}"${autoCollapse?' style="display:none"':''}>${itemsHtml}</div>
    </div>`;
  }).join('');
}

function renderOdOpenItems(){
  const section = document.getElementById('od-open-section');
  const wrap    = document.getElementById('od-open-items');
  const countEl = document.getElementById('od-open-count');
  if(!wrap) return;
  const d = load();
  const allOpen = [];
  (d._overdrachten||[]).filter(e=>!e.deleted).forEach(e=>{
    if(!Array.isArray(e.todo)) return;
    e.todo.forEach((item,i)=>{
      if(!item.done && item.text) allOpen.push({entryId:e.id,idx:i,item,entry:e});
    });
  });
  if(!allOpen.length){
    if(section) section.style.display='none';
    return;
  }
  if(section) section.style.display='';
  if(countEl) countEl.textContent = allOpen.length + ' open';
  allOpen.sort((a,b)=>{
    if(a.item.urgent !== b.item.urgent) return a.item.urgent ? -1 : 1;
    return (b.entry.ts||0) - (a.entry.ts||0);
  });
  wrap.innerHTML = allOpen.map(({entryId,idx,item,entry})=>{
    const d2 = new Date((entry.date||'')+'T12:00:00');
    const dateLabel = isNaN(d2) ? '' : d2.toLocaleDateString('nl-NL',{weekday:'short',day:'numeric',month:'short'});
    const shiftIcon = entry.shift==='avond' ? '🌙' : '🌅';
    return `<div class="od-todo-check${item.urgent?' od-todo-urgent':''}" id="od-open-td-${entryId}-${idx}" onclick="toggleOdTodo(${entryId},${idx})" style="touch-action:manipulation;">
      <div class="od-todo-check-box"><span class="ck">✓</span></div>
      <div class="od-todo-check-right">
        ${item.urgent?'<span class="od-todo-urgent-badge">!!</span>':''}
        <span class="od-todo-check-text">${esc(item.text)}</span>
        <span class="od-todo-check-meta">${shiftIcon} ${dateLabel}${entry.name?' · '+esc(entry.name):''}</span>
      </div>
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

function odExpandTodos(id){
  const container = document.getElementById('od-todos-'+id);
  const chev = document.getElementById('od-todos-chev-'+id);
  if(!container) return;
  const open = container.style.display !== 'none';
  container.style.display = open ? 'none' : 'block';
  if(chev) chev.textContent = open ? '▸' : '▾';
}

function _checkOdTodosCollapse(entryId){
  const d = load();
  const entry = (d._overdrachten||[]).find(e=>e.id===entryId);
  if(!entry || !Array.isArray(entry.todo) || !entry.todo.length) return;
  const allDone = entry.todo.every(t=>t.done);
  const label = document.getElementById('od-todos-label-'+entryId);
  const container = document.getElementById('od-todos-'+entryId);
  if(!label) return;
  if(allDone){
    label.className = 'od-section-label od-todos-done-label';
    label.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:6px;';
    label.onclick = ()=>odExpandTodos(entryId);
    label.innerHTML = `<span style="color:var(--green);">✓</span> ${entry.todo.length} actie${entry.todo.length>1?'s':''} afgerond <span id="od-todos-chev-${entryId}" style="font-size:9px;color:#aaa;margin-left:auto;">▸</span>`;
    if(container) container.style.display = 'none';
    const item = label.closest('.od-item');
    if(item) item.style.borderLeft = '';
    const badge = item?.querySelector('[style*="clay-dark"]');
    if(badge && badge.tagName === 'SPAN') badge.remove();
  } else {
    label.className = 'od-section-label';
    label.style.cssText = '';
    label.onclick = null;
    label.innerHTML = `📌 To do`;
    if(container) container.style.display = '';
  }
}

let _odEditId = null;

function openOdEdit(id){
  const d = load();
  const entry = (d._overdrachten||[]).find(e=>e.id===id);
  if(!entry) return;
  _odEditId = id;
  document.getElementById('od-edit-verslag').value = entry.verslag || '';
  odWordCount('od-edit-verslag','od-edit-verslag-wc');
  const editBuilder = document.getElementById('od-edit-todo-builder');
  if(editBuilder){
    editBuilder.innerHTML = '';
    const items = Array.isArray(entry.todo) ? entry.todo
                : (entry.todo ? [{text: entry.todo, done: false}] : []);
    items.forEach(item => editBuilder.appendChild(_makeTodoInputRow(item.text || item, item.urgent)));
    if(items.length === 0) editBuilder.appendChild(_makeTodoInputRow(''));
  }
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
  const oldTodo = Array.isArray(arr[idx].todo) ? arr[idx].todo : [];
  arr[idx].todo = _getOdTodoItems('od-edit-todo-builder').map((item, i) => ({
    text:   item.text,
    urgent: item.urgent || false,
    done:   oldTodo[i]?.done   || false,
    doneBy: oldTodo[i]?.doneBy || undefined,
    doneTs: oldTodo[i]?.doneTs || undefined,
  }));
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
    showToast(`⚠️ ${name} bestaat al`);
    input.select();
    return;
  }
  saveUsers([...users, name]);
  input.value = '';
  input.focus();
  buildUsers();
  showToast(`✓ ${name} toegevoegd`);
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
  if(!_isAdmin()) return;
  saveUsers(getUsers().filter(u=>u!==name));
  buildUsers();
  showToast(`${name} verwijderd`);
  if(navigator.vibrate) navigator.vibrate(30);
}

let _renameTarget = null;

function startRenameUser(name){
  const wrap = document.getElementById('users-list');
  if(!wrap) return;
  const row = Array.from(wrap.querySelectorAll('.user-row')).find(r => r.dataset.name === name);
  if(!row || row.classList.contains('editing')) return;
  _renameTarget = name;
  row.classList.add('editing');
  row.innerHTML = `
    <input class="user-rename-input" value="${esc(name)}" autocomplete="off" autocorrect="off" autocapitalize="words" style="touch-action:manipulation;">
    <div class="user-rename-btns">
      <button class="user-rename-save" onclick="doRenameUser()" style="touch-action:manipulation;">Opslaan</button>
      <button class="user-rename-cancel" onclick="buildUsers()" style="touch-action:manipulation;">Annuleer</button>
    </div>`;
  const input = row.querySelector('input');
  input.focus(); input.select();
  input.addEventListener('keydown', e => {
    if(e.key === 'Enter') doRenameUser();
    if(e.key === 'Escape') buildUsers();
  });
}

function doRenameUser(){
  if(!_isAdmin()) return;
  const wrap = document.getElementById('users-list');
  const input = wrap?.querySelector('.user-rename-input');
  if(!input || !_renameTarget) return;
  const oldName = _renameTarget;
  const newName = input.value.trim();
  if(!newName || newName === oldName){ buildUsers(); return; }
  const users = getUsers();
  if(users.map(u=>u.toLowerCase()).includes(newName.toLowerCase())){
    input.style.borderColor = 'var(--clay)';
    input.placeholder = 'Naam bestaat al';
    setTimeout(()=>{ input.style.borderColor=''; }, 1500);
    return;
  }
  _renameTarget = null;
  saveUsers(users.map(u => u === oldName ? newName : u));
  buildUsers();
  showToast(`✓ ${oldName} → ${newName}`);
  if(navigator.vibrate) navigator.vibrate(20);
}

function _uploadAvatar(name){
  if(!_isAdmin()) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = ()=>{
    const file = inp.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = ()=>{
        const SIZE = 120;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width-s)/2, (img.height-s)/2, s, s, 0, 0, SIZE, SIZE);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        const d = load();
        if(!d._avatars) d._avatars = {};
        d._avatars[name] = dataUrl;
        if(window._localSaveRaw) window._localSaveRaw(d);
        if(window.pushToSupabase) window.pushToSupabase(d);
        buildUsers();
        showToast(`✓ Foto opgeslagen voor ${name}`);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

function buildUsers(){
  const wrap = document.getElementById('users-list');
  if(!wrap) return;
  const users = getUsers();
  if(!users.length){
    wrap.innerHTML = '<div class="users-empty">Geen gebruikers</div>';
    return;
  }
  wrap.innerHTML = users.map(name=>{
    const av = getUserAvatar(name);
    const avatarHtml = av
      ? `<img src="${av}" class="user-row-avatar" alt="${esc(name)}">`
      : `<span class="user-row-avatar user-row-initials">${name.substring(0,2).toUpperCase()}</span>`;
    return `<div class="user-row" data-name="${esc(name)}">
      <div class="user-row-main" onclick="_uploadAvatar('${esc(name)}')" style="cursor:pointer;touch-action:manipulation;" title="Foto uploaden">
        ${avatarHtml}
        <span class="user-row-name">${esc(name)}</span>
      </div>
      <div class="user-row-btns">
        <button class="user-row-edit" onclick="startRenameUser('${esc(name)}')" ontouchend="event.preventDefault();startRenameUser('${esc(name)}');" style="touch-action:manipulation;">Naam wijzigen</button>
        <button class="user-row-del" onclick="removeUser('${esc(name)}')" ontouchend="event.preventDefault();removeUser('${esc(name)}');" style="touch-action:manipulation;">✕</button>
      </div>
    </div>`;
  }).join('');
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
  try{
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
        <textarea class="simple-note" maxlength="500" placeholder="Notitie…" oninput="audioNote('${key}',${i},this)">${esc(note)}</textarea>
      </div>`;
    }).join('');
  });
  refreshAudioCounters();
  } catch(e){ console.error('buildAudioLists error', e); }
}

function audioToggle(key, i, listId){
  const d = load();
  if(!d[key]) d[key] = {};
  if(!d[key][i]) d[key][i] = {};
  d[key][i].checked = !d[key][i].checked;
  if(d[key][i].checked){ d[key][i].ts = Date.now(); d[key][i].user = getCurrentUser(); }
  else { d[key][i].ts = null; d[key][i].user = null; }
  save(d, key);
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
  save(d, key);
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
  ['od-verslag','od-edit-verslag'].forEach(id=>{
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
document.addEventListener('blur', e=>{
  if(e.target.matches('.cam-note-input,.simple-note,.pos-note-input') && !e.target.value.trim()){
    e.target.style.height = '';
  }
}, true);

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
    tracking = startX < 16; // stricter: was 30, cam-badge starts at ~29px
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if(!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = Math.abs(e.changedTouches[0].clientY - startY);
    if(dx > 100 && dy < 50){ // stricter than before (was 80/60)
      const activePage = document.querySelector('.page.active');
      const backBtn = activePage && activePage.querySelector('.back-btn');
      if(backBtn) backBtn.click();
    }
  }, { passive: true });
})();

// ── Swipe tussen courts (left/right navigatie) ────────────────────
const COURT_SEQUENCES = {
  'page-pc':  ['page-pc','page-sl','page-sm','page-c14'],
  'page-sl':  ['page-pc','page-sl','page-sm','page-c14'],
  'page-sm':  ['page-pc','page-sl','page-sm','page-c14'],
  'page-c14': ['page-pc','page-sl','page-sm','page-c14'],
  'page-audio-pc':  ['page-audio-pc','page-audio-sl','page-audio-sm','page-audio-c14'],
  'page-audio-sl':  ['page-audio-pc','page-audio-sl','page-audio-sm','page-audio-c14'],
  'page-audio-sm':  ['page-audio-pc','page-audio-sl','page-audio-sm','page-audio-c14'],
  'page-audio-c14': ['page-audio-pc','page-audio-sl','page-audio-sm','page-audio-c14'],
};
const COURT_LABELS = {
  'page-pc':'PC','page-sl':'SL','page-sm':'SM','page-c14':'C14',
  'page-audio-pc':'PC','page-audio-sl':'SL','page-audio-sm':'SM','page-audio-c14':'C14',
};

function _updateCourtDots(pageId){
  let bar = document.getElementById('court-dot-bar');
  const seq = COURT_SEQUENCES[pageId];
  if(!seq){
    if(bar) bar.remove();
    return;
  }
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'court-dot-bar';
  }
  // Always move bar into the target page so it's visible after navigation
  const page = document.getElementById(pageId);
  if(page && !page.contains(bar)){
    const subHeader = page.querySelector('.sub-header');
    if(subHeader) subHeader.after(bar);
    else page.prepend(bar);
  }
  bar.innerHTML = seq.map(id =>
    `<span class="court-dot${id===pageId?' active':''}" onclick="goTo('${id}')">${COURT_LABELS[id]}</span>`
  ).join('');
}

(function(){
  let sx = 0, sy = 0, sTime = 0;
  document.addEventListener('touchstart', e => {
    if(e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    sTime = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if(Date.now() - sTime > 500) return; // te langzaam
    const dx = e.changedTouches[0].clientX - sx;
    const dy = Math.abs(e.changedTouches[0].clientY - sy);
    if(Math.abs(dx) < 60 || dy > 80 || sx < 30) return; // te kort, te verticaal, of edge-swipe
    const pageId = document.querySelector('.page.active')?.id;
    const seq = COURT_SEQUENCES[pageId];
    if(!seq) return;
    const idx = seq.indexOf(pageId);
    const next = dx < 0 ? seq[idx+1] : seq[idx-1];
    if(next) goTo(next);
  }, { passive: true });
})();

// ══════════════════════════════════════════════════════════════
// 🎾  GEHEIME MINI GAME — vrijgespeeld na 100%
// ══════════════════════════════════════════════════════════════
function unlockMiniGame(){
  try{ localStorage.setItem('rg_game_unlocked','1'); }catch(e){}
  setTimeout(_showMiniGameBtn, 3000); // verschijnt na de celebration
}

function _showMiniGameBtn(){
  try{ if(localStorage.getItem('rg_game_unlocked')!=='1') return; }catch(e){ return; }
  if(document.getElementById('minigame-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'minigame-btn';
  btn.title = '🎾 Geheime mini game';
  btn.textContent = '🎾';
  btn.style.display = 'flex';
  btn.onclick = openMiniGame;
  document.body.appendChild(btn);
}

function openMiniGame(){
  if(document.getElementById('mg-overlay')) return;
  const best = localStorage.getItem('rg_game_best') || '0';
  const overlay = document.createElement('div');
  overlay.id = 'mg-overlay';
  overlay.innerHTML = `
    <div id="mg-box">
      <div id="mg-hdr">
        <span id="mg-title">🎾 Roland Garros</span>
        <div id="mg-scores"><span id="mg-score">0</span><span id="mg-best-lbl">Best: ${best}</span></div>
        <button id="mg-close-btn" onclick="closeMiniGame()">✕</button>
      </div>
      <canvas id="mg-canvas"></canvas>
      <div id="mg-gameover">
        <div id="mg-over-label">GAME OVER</div>
        <div id="mg-over-score">0</div>
        <div id="mg-over-best"></div>
        <div id="mg-lb-over" class="mg-leaderboard"></div>
        <button class="mg-action-btn" onclick="startMiniGame()">Nog een keer 🎾</button>
        <button class="mg-quit-btn" onclick="closeMiniGame()">Sluiten</button>
      </div>
      <div id="mg-start" style="display:flex;">
        <div style="font-size:44px;">🎾</div>
        <div id="mg-lb-start" class="mg-leaderboard"><span class="mg-lb-loading">Laden…</span></div>
        <div id="mg-start-hint">Beweeg je vinger of muis<br>om de bal te raken</div>
        <button class="mg-action-btn" onclick="startMiniGame()">Spelen!</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden'; // prevent background scroll

  const canvas = document.getElementById('mg-canvas');
  const box    = document.getElementById('mg-box');
  const hdr    = document.getElementById('mg-hdr');
  function resizeCanvas(){
    const w = box.clientWidth;
    const h = box.clientHeight - hdr.offsetHeight;
    if(w > 0 && h > 0){ canvas.width = w; canvas.height = h; }
  }
  // Double rAF: first paints the DOM, second measures actual dimensions
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    resizeCanvas();
    _mgFetchLeaderboard().then(entries=>{
      const el = document.getElementById('mg-lb-start');
      if(el) el.innerHTML = _mgRenderLeaderboard(entries, getCurrentUser(), -1);
    });
  }));
  overlay._resize = resizeCanvas;
  window.addEventListener('resize', resizeCanvas);
}

function closeMiniGame(){
  const o = document.getElementById('mg-overlay');
  if(!o) return;
  if(o._resize) window.removeEventListener('resize', o._resize);
  if(window._mgAnim){ cancelAnimationFrame(window._mgAnim); window._mgAnim = null; }
  window._mgCleanup?.();
  document.body.style.overflow = '';
  o.remove();
}

function startMiniGame(){
  const canvas = document.getElementById('mg-canvas');
  if(!canvas) return;

  document.getElementById('mg-start').style.display    = 'none';
  document.getElementById('mg-gameover').style.display = 'none';

  if(window._mgAnim){ cancelAnimationFrame(window._mgAnim); window._mgAnim = null; }
  window._mgCleanup?.();

  const ctx = canvas.getContext('2d');
  let W = canvas.width, H = canvas.height;

  const BALL_R      = Math.max(9,  Math.round(W * 0.026));
  const RACKET_H    = Math.max(10, Math.round(H * 0.022));
  const RACKET_W0   = Math.round(W * 0.24);
  const RACKET_Y    = H - RACKET_H - Math.round(H * 0.055);
  const BASE_SPD    = 3.8;

  let ball   = { x: W/2, y: H*0.28, vx: (Math.random()>0.5?1:-1)*2.6, vy: BASE_SPD };
  let racket = { x: W/2, w: RACKET_W0 };
  let targetX = W/2;
  let score = 0, speed = 1, running = true;

  function onMouseMove(e){
    const r = canvas.getBoundingClientRect();
    targetX = e.clientX - r.left;
  }
  function onTouch(e){
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    targetX = e.touches[0].clientX - r.left;
  }
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('touchstart', onTouch, {passive:false});
  canvas.addEventListener('touchmove',  onTouch, {passive:false});
  window._mgCleanup = ()=>{
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('touchstart', onTouch);
    canvas.removeEventListener('touchmove',  onTouch);
  };

  function flashLevel(txt){
    document.getElementById('mg-level-flash')?.remove();
    const el = document.createElement('div');
    el.id = 'mg-level-flash';
    el.textContent = txt;
    document.getElementById('mg-box').appendChild(el);
    setTimeout(()=>el.remove(), 800);
  }

  function drawScene(){
    W = canvas.width; H = canvas.height;

    // Clay court
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'#A83208'); g.addColorStop(1,'#C1440E');
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);

    // Court lines
    ctx.strokeStyle='rgba(255,255,255,.16)'; ctx.lineWidth=2;
    const ml=W*.07, mr=W*.93, mt=H*.1, mb=H*.87, mid=H*.48;
    [[ml,mt,mr,mt],[ml,mb,mr,mb],[ml,mt,ml,mb],[mr,mt,mr,mb],
     [ml,mid,mr,mid],[W/2,mt,W/2,mid]].forEach(([x1,y1,x2,y2])=>{
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });

    // Ball shadow
    ctx.save(); ctx.globalAlpha=.25;
    ctx.fillStyle='#000';
    ctx.beginPath(); ctx.ellipse(ball.x,RACKET_Y+RACKET_H,BALL_R*.9,BALL_R*.25,0,0,Math.PI*2); ctx.fill();
    ctx.restore();

    // Ball
    ctx.save();
    ctx.shadowColor='rgba(0,0,0,.55)'; ctx.shadowBlur=10; ctx.shadowOffsetY=3;
    ctx.fillStyle='#fff';
    ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur=0;
    // Felt seam
    ctx.strokeStyle='rgba(160,210,160,.55)'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(ball.x,ball.y,BALL_R*.62, .35, Math.PI-.35); ctx.stroke();
    ctx.beginPath(); ctx.arc(ball.x,ball.y,BALL_R*.62, Math.PI+.35, 2*Math.PI-.35); ctx.stroke();
    ctx.restore();

    // Racket
    const rx = racket.x - racket.w/2;
    ctx.save();
    ctx.shadowColor='rgba(0,0,0,.4)'; ctx.shadowBlur=8;
    ctx.fillStyle='#C9A84C';
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(rx, RACKET_Y, racket.w, RACKET_H, RACKET_H/2);
    else ctx.rect(rx, RACKET_Y, racket.w, RACKET_H);
    ctx.fill();
    ctx.shadowBlur=0;
    // Strings
    ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=1;
    const sn=5, sw=racket.w/sn;
    for(let i=1;i<sn;i++){
      ctx.beginPath(); ctx.moveTo(rx+sw*i,RACKET_Y+2); ctx.lineTo(rx+sw*i,RACKET_Y+RACKET_H-2); ctx.stroke();
    }
    ctx.restore();
  }

  async function endGame(){
    running = false;
    window._mgCleanup?.();
    window._mgAnim = null;

    const prev = parseInt(localStorage.getItem('rg_game_best')||'0');
    const best = Math.max(score, prev);
    if(best > prev) localStorage.setItem('rg_game_best', best);
    document.getElementById('mg-best-lbl').textContent = 'Best: '+best;
    document.getElementById('mg-over-score').textContent = score;
    document.getElementById('mg-over-best').textContent =
      best > prev ? '🏆 Nieuw record!' : 'Beste: '+best;
    document.getElementById('mg-gameover').style.display = 'flex';

    const player = getCurrentUser() || 'Anoniem';
    const lbEl = document.getElementById('mg-lb-over');
    if(lbEl) lbEl.innerHTML = '<span class="mg-lb-loading">Opslaan…</span>';
    await _mgSubmitScore(score, player);
    const entries = await _mgFetchLeaderboard();
    if(lbEl) lbEl.innerHTML = _mgRenderLeaderboard(entries, player, score);
  }

  function loop(){
    if(!running) return;

    // Smooth racket follow
    racket.x += (targetX - racket.x) * 0.18;
    racket.x = Math.max(racket.w/2, Math.min(W - racket.w/2, racket.x));

    // Move ball
    ball.x += ball.vx * speed;
    ball.y += ball.vy * speed;

    // Wall bounces
    if(ball.x - BALL_R < 0){ ball.x = BALL_R; ball.vx = Math.abs(ball.vx); }
    if(ball.x + BALL_R > W){ ball.x = W-BALL_R; ball.vx = -Math.abs(ball.vx); }
    if(ball.y - BALL_R < 0){ ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }

    // Racket hit
    const rx = racket.x - racket.w/2;
    const ballBottom = ball.y + BALL_R;
    if(ball.vy > 0 && ballBottom >= RACKET_Y && ballBottom <= RACKET_Y + RACKET_H + speed*3 &&
       ball.x >= rx - BALL_R*.5 && ball.x <= rx + racket.w + BALL_R*.5){
      ball.y = RACKET_Y - BALL_R;
      ball.vy = -Math.abs(ball.vy);
      const offset = (ball.x - racket.x) / (racket.w/2);
      ball.vx = offset * 7;
      ball.vx = Math.max(-8, Math.min(8, ball.vx));
      score++;
      document.getElementById('mg-score').textContent = score;
      // Speed up every 5 hits
      if(score % 5 === 0){
        speed = Math.min(3.2, speed + 0.12);
        flashLevel('⚡ +'+(Math.round(speed*10)/10)+'x');
      }
      // Narrow racket every 8 hits
      if(score % 8 === 0){
        racket.w = Math.max(RACKET_W0 * 0.35, racket.w - RACKET_W0 * 0.07);
        flashLevel('🎾 Smaller!');
      }
    }

    // Ball out of bounds → game over
    if(ball.y - BALL_R > H){ drawScene(); endGame(); return; }

    drawScene();
    window._mgAnim = requestAnimationFrame(loop);
  }

  loop();
}

async function _mgFetchLeaderboard(){
  const sc = window._supaClient;
  if(!sc) return [];
  try{
    const { data, error } = await sc
      .from('game_scores')
      .select('player, score')
      .order('score', { ascending: false })
      .limit(300);
    if(error || !data) return [];
    const bests = {};
    data.forEach(r => { if(!bests[r.player] || r.score > bests[r.player]) bests[r.player] = r.score; });
    return Object.entries(bests)
      .map(([player, score]) => ({ player, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  } catch(e){ return []; }
}

async function _mgSubmitScore(score, player){
  const sc = window._supaClient;
  if(!sc || !score) return;
  try{ await sc.from('game_scores').insert({ player: player || 'Anoniem', score, ts: Date.now() }); }
  catch(e){}
}

function _mgRenderLeaderboard(entries, currentPlayer, currentScore){
  if(!entries.length) return '<span class="mg-lb-loading">Nog geen scores</span>';
  const medals = ['🥇','🥈','🥉'];
  const rows = entries.map((e, i) => {
    const isMe = e.player === currentPlayer && e.score >= currentScore;
    return `<div class="mg-lb-row${isMe?' mg-lb-me':''}">
      <span class="mg-lb-rank">${medals[i] || (i+1)+'.'}</span>
      <span class="mg-lb-player">${esc(e.player)}</span>
      <span class="mg-lb-score">${e.score}</span>
    </div>`;
  }).join('');
  return `<div class="mg-lb-title">🏆 Top scores</div>${rows}`;
}
