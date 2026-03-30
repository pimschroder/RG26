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
}
