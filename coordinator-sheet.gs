// Roland Garros 2026 — Live Coordinator Sheet
// Plak dit in Google Apps Script (Extensions → Apps Script)
// Stel daarna een trigger in: Run → syncRG26 → elke minuut

const SUPABASE_URL = "https://owjccmlgfhbusncvmbac.supabase.co";
const SUPABASE_KEY = "sb_publishable_m5WPUe6APhOqHUQZOpj0-g_XZxzTVB5";

const CAM_ROWS = {
  pc: {
    default: ["FIBERS","SMPTE","SHED/CCU","CAMERA"],
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
    24: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
  },
  sl: {
    default: ["FIBERS","SMPTE","SHED/CCU","CAMERA"],
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
    20: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"],
  },
  sm:  { default: ["FIBERS","SMPTE","SHED/CCU","CAMERA"], 1: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"], 2: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"], 7: ["CAMERA"], 8: ["FIBERS","CAMERA","MOUNT"], 9: ["FIBERS","CAMERA","MOUNT"], 10: ["FIBERS","CAMERA"], 11: ["FIBERS","CAMERA"], 13: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"] },
  c14: { default: ["FIBERS","SMPTE","SHED/CCU","CAMERA"], 1: ["FIBERS","SMPTE","CAMERA","MOUNT"], 5: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"], 6: ["FIBERS","SMPTE","SHED/CCU","CAMERA","MOUNT"] },
};

function getRows(court, camNum) {
  const c = CAM_ROWS[court];
  return (c && c[camNum]) || c.default || ["FIBERS","SMPTE","SHED/CCU","CAMERA"];
}

function fetchData() {
  const res = UrlFetchApp.fetch(
    `${SUPABASE_URL}/rest/v1/checklist_state?id=eq.1&select=data`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return JSON.parse(res.getContentText())[0]?.data || {};
}

function syncRG26() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const data = fetchData();
  const now  = new Date();

  // ── Tab 1: Overzicht ───────────────────────────────────────────
  let overview = ss.getSheetByName("Overzicht") || ss.insertSheet("Overzicht");
  overview.clearContents();

  const courts = [
    { key: "pc",  label: "Court Philippe-Chatrier", cams: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24] },
    { key: "sl",  label: "Court Suzanne-Lenglen",   cams: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20] },
    { key: "sm",  label: "Court Simonne-Mathieu",   cams: [1,2,3,4,5,6,7,8,9,10,11,12,13] },
    { key: "c14", label: "Court 14",                cams: [1,2,3,4,5,6,7] },
  ];

  // Header
  overview.getRange(1,1,1,5).setValues([["🎾 RG2026 — Live Status", "", "", "", "Bijgewerkt: " + now.toLocaleTimeString("nl-NL")]]);
  overview.getRange(1,1,1,5).setFontWeight("bold").setBackground("#8B2E07").setFontColor("#F5EDD8");
  overview.getRange(1,5).setHorizontalAlignment("right");

  let row = 3;
  let grandDone = 0, grandTotal = 0;

  courts.forEach(court => {
    const courtData = data[court.key] || {};
    let done = 0, total = 0;

    // Court header row
    overview.getRange(row,1,1,5).setValues([[court.label, "", "", "Gedaan", "Totaal"]]);
    overview.getRange(row,1,1,5).setFontWeight("bold").setBackground("#C1440E").setFontColor("white");
    row++;

    court.cams.forEach(camNum => {
      const camData = courtData[`cam${camNum}`] || {};
      const rows = getRows(court.key, camNum);
      const camDone  = rows.filter(r => camData[r]?.checked).length;
      const camTotal = rows.length;
      done  += camDone;
      total += camTotal;

      const pct      = camTotal > 0 ? Math.round(camDone/camTotal*100) : 0;
      const allDone  = camDone === camTotal;
      const lastUser = rows.map(r => camData[r]?.user).filter(Boolean).pop() || "";
      const lastTs   = rows.map(r => camData[r]?.ts).filter(Boolean).sort().pop();
      const lastTime = lastTs ? new Date(lastTs).toLocaleTimeString("nl-NL", {hour:"2-digit",minute:"2-digit"}) : "";

      overview.getRange(row,1,1,5).setValues([
        [`  CAM ${camNum}`, `${pct}%`, allDone ? "✅ Klaar" : `${camDone}/${camTotal} rijen`, lastUser, lastTime]
      ]);
      if(allDone) {
        overview.getRange(row,1,1,5).setBackground("#e8f5e3");
      } else if(camDone > 0) {
        overview.getRange(row,1,1,5).setBackground("#fff8e0");
      } else {
        overview.getRange(row,1,1,5).setBackground(null);
      }
      row++;
    });

    // Court totaal
    const courtPct = total > 0 ? Math.round(done/total*100) : 0;
    overview.getRange(row,1,1,5).setValues([[`Totaal ${court.label}`, `${courtPct}%`, `${done}/${total}`, "", ""]]);
    overview.getRange(row,1,1,5).setFontWeight("bold").setBackground(done===total ? "#2D5A1B" : "#555").setFontColor("white");
    grandDone += done; grandTotal += total;
    row += 2;
  });

  // Grand total
  const gPct = grandTotal > 0 ? Math.round(grandDone/grandTotal*100) : 0;
  overview.getRange(row,1,1,5).setValues([["🏆 TOTAAL CAMERAS", `${gPct}%`, `${grandDone}/${grandTotal}`, "", ""]]);
  overview.getRange(row,1,1,5).setFontWeight("bold").setFontSize(12)
    .setBackground(grandDone===grandTotal ? "#2D5A1B" : "#8B2E07").setFontColor("white");

  overview.setColumnWidth(1, 260);
  overview.setColumnWidth(2, 60);
  overview.setColumnWidth(3, 100);
  overview.setColumnWidth(4, 100);
  overview.setColumnWidth(5, 80);

  Logger.log(`Sync OK — ${grandDone}/${grandTotal} (${gPct}%) — ${now}`);

  // ── Tab 2: Commentaar ──────────────────────────────────────────
  let commSheet = ss.getSheetByName("Commentaar") || ss.insertSheet("Commentaar");
  commSheet.clearContents();

  const commMap = [
    { key: "comm_pc4th", label: "PC 4th Floor", positions: ['403','404','405','406','407','408','409','410','411','412','413','414'] },
    { key: "comm_pc5th", label: "PC 5th Floor", positions: ['501','502','503','504','505','506'] },
    { key: "comm_sl",    label: "SL",            positions: ['306','307','308','309'] },
    { key: "comm_sm",    label: "SM",            positions: ['TV1','TV2','TV3'] },
  ];
  const POS_CHECKS = ["Monitors","Tablet","Audio","Netjes"];

  commSheet.getRange(1,1,1,5).setValues([["🎙 Commentaar — Live Status","","","",`Bijgewerkt: ${now.toLocaleTimeString("nl-NL")}`]]);
  commSheet.getRange(1,1,1,5).setFontWeight("bold").setBackground("#8B2E07").setFontColor("#F5EDD8");

  let crow = 3;
  commMap.forEach(({ key, label, positions }) => {
    const boxData = data[key] || {};
    let done = 0, total = 0;
    commSheet.getRange(crow,1,1,5).setValues([[label,"","","Gedaan","Totaal"]]);
    commSheet.getRange(crow,1,1,5).setFontWeight("bold").setBackground("#C1440E").setFontColor("white");
    crow++;
    positions.forEach(pos => {
      const pd = boxData[pos] || {};
      const posDone  = POS_CHECKS.filter(c => pd[c]).length;
      const posTotal = POS_CHECKS.length;
      done  += posDone;
      total += posTotal;
      const allDone = posDone === posTotal;
      const lastUser = POS_CHECKS.map(c => pd[c+"_user"]).filter(Boolean).pop() || "";
      const lastTs   = POS_CHECKS.map(c => pd[c+"_ts"]).filter(Boolean).sort().pop();
      const lastTime = lastTs ? new Date(lastTs).toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"}) : "";
      commSheet.getRange(crow,1,1,5).setValues([[`  ${pos}`, allDone?"✅ Klaar":`${posDone}/${posTotal}`, "", lastUser, lastTime]]);
      if(allDone) commSheet.getRange(crow,1,1,5).setBackground("#e8f5e3");
      else if(posDone > 0) commSheet.getRange(crow,1,1,5).setBackground("#fff8e0");
      else commSheet.getRange(crow,1,1,5).setBackground(null);
      crow++;
    });
    const pct = total > 0 ? Math.round(done/total*100) : 0;
    commSheet.getRange(crow,1,1,5).setValues([[`Totaal ${label}`, `${pct}%`, `${done}/${total}`, "", ""]]);
    commSheet.getRange(crow,1,1,5).setFontWeight("bold").setBackground(done===total?"#2D5A1B":"#555").setFontColor("white");
    crow += 2;
  });

  commSheet.setColumnWidth(1, 220);
  commSheet.setColumnWidth(2, 100);
  commSheet.setColumnWidth(3, 80);
  commSheet.setColumnWidth(4, 100);
  commSheet.setColumnWidth(5, 80);

  // ── Tab 3: Audio ───────────────────────────────────────────────
  let audioSheet = ss.getSheetByName("Audio") || ss.insertSheet("Audio");
  audioSheet.clearContents();

  const audioMap = [
    { key: "audio_pc",  label: "Microfoons PC",  count: 28 },
    { key: "audio_sl",  label: "Microfoons SL",  count: 28 },
    { key: "audio_sm",  label: "Microfoons SM",  count: 19 },
    { key: "audio_c14", label: "Microfoons C14", count: 16 },
    { key: "sb_pc",     label: "Stageboxes PC",  count: 4 },
    { key: "sb_sl",     label: "Stageboxes SL",  count: 4 },
    { key: "sb_sm",     label: "Stageboxes SM",  count: 2 },
    { key: "sb_c14",    label: "Stageboxes C14", count: 2 },
  ];

  audioSheet.getRange(1,1,1,4).setValues([["🎵 Audio — Live Status","","",`Bijgewerkt: ${now.toLocaleTimeString("nl-NL")}`]]);
  audioSheet.getRange(1,1,1,4).setFontWeight("bold").setBackground("#8B2E07").setFontColor("#F5EDD8");

  let arow = 3;
  let audioDone = 0, audioTotal = 0;
  audioMap.forEach(({ key, label, count }) => {
    const kd = data[key] || {};
    let done = 0;
    for(let i = 0; i < count; i++){
      if(kd[i] && kd[i].checked) done++;
    }
    const pct = Math.round(done/count*100);
    const allDone = done === count;
    audioSheet.getRange(arow,1,1,4).setValues([[label, `${pct}%`, `${done}/${count}`, allDone?"✅ Klaar":""]]);
    if(allDone) audioSheet.getRange(arow,1,1,4).setBackground("#e8f5e3");
    else if(done > 0) audioSheet.getRange(arow,1,1,4).setBackground("#fff8e0");
    else audioSheet.getRange(arow,1,1,4).setBackground(null);
    audioDone  += done;
    audioTotal += count;
    arow++;
  });

  arow++;
  const aPct = audioTotal > 0 ? Math.round(audioDone/audioTotal*100) : 0;
  audioSheet.getRange(arow,1,1,4).setValues([["🏆 TOTAAL AUDIO", `${aPct}%`, `${audioDone}/${audioTotal}`, ""]]);
  audioSheet.getRange(arow,1,1,4).setFontWeight("bold").setFontSize(12)
    .setBackground(audioDone===audioTotal?"#2D5A1B":"#8B2E07").setFontColor("white");

  audioSheet.setColumnWidth(1, 200);
  audioSheet.setColumnWidth(2, 60);
  audioSheet.setColumnWidth(3, 80);
  audioSheet.setColumnWidth(4, 100);
}
