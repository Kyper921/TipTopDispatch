/** =======================================
 * Route Sync Unified V4 (RegEd + SpecEd)
 * =======================================
 * One script for both sources:
 * - Routes/RegEd: Google Docs (red stop lines)
 * - Routes/SpecEd/<bus>: PDF route sheets
 *
 * Output:
 * - OUTPUT_ROOT/Bus Stops/<bus>/<SCHOOL (PERIOD)>.json
 * - Optional spreadsheet mirror per route
 *
 * Required setup:
 * - Script property: GEMINI_API_KEY
 * - Advanced services: Drive API, Docs API
 * - Apps Script Maps service enabled
 */

/** ========== CONFIG ========== **/
const ROUTES_ROOT_FOLDER_ID_V4 = '1HxXVpIlQaGQneXqpZU49Wltk-_0Or0gD';
const OUTPUT_ROOT_FOLDER_ID_V4 = '1cVtiffSIG9oWwHL9SL6juNEqAxcaRJVB';
const REGED_FOLDER_NAME_V4 = 'RegEd';
const SPECED_FOLDER_NAME_V4 = 'SpecEd';
const BUS_STOPS_FOLDER_NAME_V4 = 'Bus Stops';
const LOG_SHEET_NAME_V4 = 'Logs';
const STATE_FILE_NAME_V4 = '_route_sync_unified_v4_state.json';
const COUNTY_SUFFIX_V4 = ', Howard County, Maryland';
const MODEL_V4 = 'gemini-2.5-flash';

const RECENT_DAYS_V4 = 14;
const BATCH_SIZE_V4 = 6;
const WRITE_JSON_V4 = true;
const WRITE_SHEETS_V4 = true; // set false if you want JSON-only output

/** ========== ENTRYPOINTS ========== **/
function syncRoutesUnifiedV4() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('syncRoutesUnifiedV4: another run is active. Skipping.');
    return;
  }

  try {
    const state = loadStateV4_();
    if (!Array.isArray(state.queue) || state.pos >= state.queue.length) {
      rebuildQueueV4_(state);
    }

    const outputRoot = DriveApp.getFolderById(OUTPUT_ROOT_FOLDER_ID_V4);
    const busStopsRoot = getOrCreateSubfolderV4_(outputRoot, BUS_STOPS_FOLDER_NAME_V4);
    const logs = [];
    const end = Math.min(state.pos + BATCH_SIZE_V4, state.queue.length);

    for (; state.pos < end; state.pos++) {
      const item = state.queue[state.pos];
      if (!item || !item.fileId || !item.routeType) continue;

      const prev = state.processed[item.fileId];
      if (String(prev || '') === String(item.updatedMs || '')) {
        logs.push(`[SKIP] ${item.routeType} ${item.fileName}: unchanged`);
        continue;
      }

      try {
        let routes = [];
        if (item.routeType === 'REGED_DOC') {
          routes = parseRegEdDocV4_(item.fileId, item.fileName, item.busNumberHint);
        } else if (item.routeType === 'SPECED_PDF') {
          const text = ocrPdfToTextV4_(item.fileId);
          routes = extractSpecEdRoutesV4_(text, item.schoolNameHint || stripExtV4_(item.fileName), item.busNumberHint || '');
        }

        publishRoutesV4_(routes, item, busStopsRoot, state, logs);
        state.processed[item.fileId] = String(item.updatedMs || 0);
      } catch (err) {
        logs.push(`[ERROR] ${item.routeType} ${item.fileName}: ${errTextV4_(err)}`);
      }
    }

    appendLogsV4_(outputRoot, logs);

    if (state.pos < state.queue.length) {
      scheduleNextV4_();
    } else {
      state.queue = [];
      state.pos = 0;
      removeTriggersV4_();
      Logger.log('syncRoutesUnifiedV4: queue complete.');
    }
    saveStateV4_(state);
  } finally {
    lock.releaseLock();
  }
}

function rebuildQueueOnlyV4() {
  const state = loadStateV4_();
  rebuildQueueV4_(state);
  saveStateV4_(state);
}

function resetRouteSyncUnifiedV4() {
  removeTriggersV4_();
  saveStateV4_({ queue: [], pos: 0, processed: {}, geocodeCache: {} });
}

/** ========== QUEUE ========== **/
function rebuildQueueV4_(state) {
  const root = DriveApp.getFolderById(ROUTES_ROOT_FOLDER_ID_V4);
  const regEd = getSubfolderByNameV4_(root, REGED_FOLDER_NAME_V4);
  const specEd = getSubfolderByNameV4_(root, SPECED_FOLDER_NAME_V4);
  if (!regEd) throw new Error(`Missing "${REGED_FOLDER_NAME_V4}" under Routes root`);
  if (!specEd) throw new Error(`Missing "${SPECED_FOLDER_NAME_V4}" under Routes root`);

  const cutoff = new Date(Date.now() - RECENT_DAYS_V4 * 24 * 60 * 60 * 1000);
  const queue = [];

  const regFiles = regEd.getFiles();
  while (regFiles.hasNext()) {
    const f = regFiles.next();
    if (f.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
    if (!isRecentV4_(f.getLastUpdated(), f.getDateCreated(), cutoff)) continue;
    queue.push({
      routeType: 'REGED_DOC',
      fileId: f.getId(),
      fileName: f.getName(),
      updatedMs: f.getLastUpdated() ? f.getLastUpdated().getTime() : 0,
      busNumberHint: extractBusNumberV4_(f.getName()),
      schoolNameHint: inferSchoolNameV4_(f.getName())
    });
  }

  const busFolders = specEd.getFolders();
  while (busFolders.hasNext()) {
    const busFolder = busFolders.next();
    const busHint = normalizeBusV4_(busFolder.getName());
    const files = busFolder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.getMimeType() !== MimeType.PDF) continue;
      if (!isRecentV4_(f.getLastUpdated(), f.getDateCreated(), cutoff)) continue;
      queue.push({
        routeType: 'SPECED_PDF',
        fileId: f.getId(),
        fileName: f.getName(),
        updatedMs: f.getLastUpdated() ? f.getLastUpdated().getTime() : 0,
        busNumberHint: busHint || extractBusNumberV4_(f.getName()),
        schoolNameHint: inferSchoolNameV4_(f.getName())
      });
    }
  }

  queue.sort(function(a, b) { return Number(b.updatedMs || 0) - Number(a.updatedMs || 0); });
  state.queue = queue;
  state.pos = 0;
  Logger.log(`rebuildQueueV4_: queued ${queue.length} files`);
}

/** ========== REGED DOC PARSE ========== **/
function parseRegEdDocV4_(docId, docName, busHint) {
  const doc = withRetryV4_(function() { return Docs.Documents.get(docId); }, 3, 400);
  const redLines = extractRedParagraphLinesV4_(doc);
  const parsed = [];
  for (var i = 0; i < redLines.length; i++) {
    const stop = parseRegEdStopLineV4_(redLines[i]);
    if (stop) parsed.push(stop);
  }
  if (!parsed.length) return [];

  const grouped = { AM: [], PM: [], 'Mid-day': [], Route: [] };
  for (var j = 0; j < parsed.length; j++) {
    const p = periodFromTimeV4_(parsed[j].time);
    grouped[p].push(parsed[j]);
  }
  if (grouped.AM.length + grouped.PM.length + grouped['Mid-day'].length === 0) {
    grouped.Route = parsed.slice();
  }

  const bus = normalizeBusV4_(busHint || extractBusNumberV4_(docName)) || 'N-A';
  const school = inferSchoolNameV4_(docName) || 'Unknown Route';
  const routes = [];
  for (const k in grouped) {
    if (!grouped[k].length) continue;
    routes.push({
      busNumber: bus,
      schoolName: school,
      period: k,
      stops: grouped[k].map(function(s) { return { time: s.time || '', location: s.location || '', students: [] }; })
    });
  }
  return routes;
}

function extractRedParagraphLinesV4_(doc) {
  const lines = [];
  const content = doc && doc.body && doc.body.content ? doc.body.content : [];
  for (let i = 0; i < content.length; i++) {
    const para = content[i].paragraph;
    if (!para || !Array.isArray(para.elements)) continue;
    let hasRed = false;
    let txt = '';
    for (let j = 0; j < para.elements.length; j++) {
      const tr = para.elements[j] && para.elements[j].textRun;
      if (!tr || !tr.content) continue;
      txt += tr.content;
      if (isRedStyleV4_(tr.textStyle)) hasRed = true;
    }
    if (!hasRed) continue;
    const clean = normalizeWsV4_(txt);
    if (clean) lines.push(clean);
  }
  return lines;
}

function isRedStyleV4_(style) {
  const rgb = style && style.foregroundColor && style.foregroundColor.color && style.foregroundColor.color.rgbColor;
  if (!rgb) return false;
  return Number(rgb.red || 0) >= 0.7 && Number(rgb.green || 0) <= 0.25 && Number(rgb.blue || 0) <= 0.25;
}

function parseRegEdStopLineV4_(line) {
  const up = String(line || '').toUpperCase();
  if (!up) return null;
  if (/^(LEFT|RIGHT|TURN|PROCEED|CONTINUE|DO NOT|BUS\s+\d+|ARRIVE|DEPART)/.test(up)) return null;
  if (/^\(?\d+\s*(ST|ND|RD|TH)\b/.test(up)) return null;

  const m = line.match(/^(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s+(.+)$/i);
  if (m) return { time: normalizeTimeV4_(m[1]), location: cleanLocationV4_(m[2]) };

  if (looksLikeLocationV4_(up)) return { time: '', location: cleanLocationV4_(line) };
  return null;
}

function looksLikeLocationV4_(up) {
  if (up.length < 6) return false;
  if (up.indexOf('/') >= 0) return true;
  if (/\d/.test(up)) return true;
  return /\b(ROAD|RD|STREET|ST|AVENUE|AVE|DRIVE|DR|COURT|CT|WAY|LANE|LN|PLACE|PL|CIRCLE|CIR|PARKWAY|PKWY)\b/.test(up);
}

/** ========== SPECED PARSE ========== **/
function ocrPdfToTextV4_(fileId) {
  return withRetryV4_(function() {
    const copied = Drive.Files.copy(
      { mimeType: 'application/vnd.google-apps.document', title: `tmp-ocr ${new Date().toISOString()}` },
      fileId,
      { ocr: true, ocrLanguage: 'en' }
    );
    const docId = copied.id;
    try {
      const txt = DocumentApp.openById(docId).getBody().getText();
      return String(txt || '').trim();
    } finally {
      Drive.Files.trash(docId);
    }
  }, 3, 500);
}

function extractSpecEdRoutesV4_(text, fallbackSchool, fallbackBus) {
  if (!text) return [];
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY script property');

  const prompt = [
    'Return ONLY a JSON array. No prose.',
    'interface Student { name: string; contactName?: string; phoneNumber?: string; otherEquipment?: string; }',
    'interface StopTime { time: string; location: string; students: Student[]; }',
    'interface BusRoute { busNumber: string; schoolName: string; stops: StopTime[]; }',
    'Rules:',
    '- Exclude school destination stop.',
    '- Driving instructions (LEFT/RIGHT ON...) are not stops.',
    '- If nothing valid, return [].',
    'TEXT:',
    '---',
    text,
    '---'
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_V4}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      response_mime_type: 'application/json',
      response_schema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            busNumber: { type: 'STRING' },
            schoolName: { type: 'STRING' },
            stops: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  time: { type: 'STRING' },
                  location: { type: 'STRING' },
                  students: {
                    type: 'ARRAY',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        name: { type: 'STRING' },
                        contactName: { type: 'STRING' },
                        phoneNumber: { type: 'STRING' },
                        otherEquipment: { type: 'STRING' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  const res = withRetryV4_(function() {
    return UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  }, 3, 1000);

  if (res.getResponseCode() !== 200) throw new Error(`Gemini API ${res.getResponseCode()}: ${res.getContentText()}`);
  const body = JSON.parse(res.getContentText());
  const txt = body && body.candidates && body.candidates[0] && body.candidates[0].content &&
    body.candidates[0].content.parts && body.candidates[0].content.parts[0] &&
    body.candidates[0].content.parts[0].text;
  if (!txt) return [];

  let parsed = [];
  try { parsed = JSON.parse(txt); } catch (_err) { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  if (!parsed.length) {
    return [{ busNumber: fallbackBus, schoolName: fallbackSchool, stops: [] }];
  }
  return parsed;
}

/** ========== PUBLISH ========== **/
function publishRoutesV4_(routes, item, busStopsRoot, state, logs) {
  if (!Array.isArray(routes) || !routes.length) {
    logs.push(`[WARN] ${item.fileName}: no routes extracted`);
    return;
  }

  const cleaned = routes.map(function(r) {
    return cleanRouteV4_(r, item.schoolNameHint || '', item.busNumberHint || '');
  }).filter(function(r) { return r.stops && r.stops.length; });
  if (!cleaned.length) {
    logs.push(`[WARN] ${item.fileName}: no valid stops after cleanup`);
    return;
  }

  geocodeStopsV4_(cleaned, state);

  for (let i = 0; i < cleaned.length; i++) {
    const route = cleaned[i];
    const busFolder = getOrCreateSubfolderV4_(busStopsRoot, route.busNumber || 'N-A');
    const routeName = canonicalRouteFileStemV4_(route.schoolName, route.stops);

    if (WRITE_JSON_V4) {
      const artifact = {
        meta: {
          sourceType: item.routeType,
          sourceFileId: item.fileId,
          sourceFileName: item.fileName,
          sourceUpdatedMs: item.updatedMs || 0,
          generatedAt: new Date().toISOString(),
          model: item.routeType === 'SPECED_PDF' ? MODEL_V4 : 'deterministic-red-lines'
        },
        busNumber: route.busNumber,
        schoolName: route.schoolName,
        period: canonicalPeriodV4_(route.stops, route.schoolName),
        stops: route.stops
      };
      const jsonUrl = upsertJsonV4_(busFolder, `${routeName}.json`, artifact);
      logs.push(`[OK] ${route.busNumber} ${routeName}.json -> ${jsonUrl}`);
    }

    if (WRITE_SHEETS_V4) {
      const sheetUrl = upsertSheetV4_(busFolder, routeName, route);
      logs.push(`[OK] ${route.busNumber} ${routeName} (sheet) -> ${sheetUrl}`);
    }
  }
}

function cleanRouteV4_(route, fallbackSchool, fallbackBus) {
  const school = String((route && route.schoolName) || fallbackSchool || '').trim() || 'Unknown Route';
  let bus = normalizeBusV4_((route && route.busNumber) || fallbackBus || '');
  if (!bus) bus = 'N-A';

  const dedupe = {};
  const outStops = [];
  const arr = (route && Array.isArray(route.stops)) ? route.stops : [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (!s || !s.location) continue;
    const loc = cleanLocationV4_(s.location);
    if (!loc) continue;
    if (loc.toLowerCase() === school.toLowerCase()) continue;
    if (/^(LEFT|RIGHT|TURN|PROCEED|CONTINUE)\b/i.test(loc)) continue;
    const time = normalizeTimeV4_(String(s.time || ''));
    const key = `${time}|${loc}`.toLowerCase();
    if (dedupe[key]) continue;
    dedupe[key] = true;
    outStops.push({
      time: time,
      location: loc,
      students: Array.isArray(s.students) ? s.students : []
    });
  }

  return { busNumber: bus, schoolName: school, stops: outStops };
}

/** ========== GEOCODING ========== **/
function geocodeStopsV4_(routes, state) {
  if (!state.geocodeCache) state.geocodeCache = {};
  const geocoder = Maps.newGeocoder().setRegion('us');

  for (let r = 0; r < routes.length; r++) {
    for (let i = 0; i < routes[r].stops.length; i++) {
      const stop = routes[r].stops[i];
      const query = `${stop.location}${COUNTY_SUFFIX_V4}`;
      const key = query.toLowerCase();
      const cached = state.geocodeCache[key];
      if (cached && typeof cached.lat === 'number' && typeof cached.lng === 'number') {
        stop.latitude = cached.lat;
        stop.longitude = cached.lng;
        continue;
      }
      const res = withRetryV4_(function() { return geocoder.geocode(query); }, 3, 500);
      const loc = res && res.results && res.results[0] && res.results[0].geometry && res.results[0].geometry.location;
      if (loc) {
        stop.latitude = loc.lat;
        stop.longitude = loc.lng;
        state.geocodeCache[key] = { lat: loc.lat, lng: loc.lng };
      } else {
        stop.geocodeError = `No match for "${stop.location}"`;
      }
      Utilities.sleep(150);
    }
  }
}

/** ========== OUTPUT HELPERS ========== **/
function upsertJsonV4_(folder, fileName, obj) {
  const it = folder.getFilesByName(fileName);
  const payload = JSON.stringify(obj, null, 2);
  let f;
  if (it.hasNext()) {
    f = it.next();
    f.setContent(payload);
  } else {
    f = folder.createFile(fileName, payload, MimeType.PLAIN_TEXT);
  }
  return `https://drive.google.com/file/d/${f.getId()}/view`;
}

function upsertSheetV4_(busFolder, sheetName, route) {
  let file = null;
  const exact = busFolder.getFilesByName(sheetName);
  if (exact.hasNext()) file = exact.next();

  let ss;
  if (file) {
    ss = SpreadsheetApp.openById(file.getId());
    if (file.getName() !== sheetName) file.setName(sheetName);
  } else {
    ss = SpreadsheetApp.create(sheetName);
    DriveApp.getFileById(ss.getId()).moveTo(busFolder);
  }

  const sh = ss.getSheets()[0] || ss.insertSheet();
  sh.clear({ contentsOnly: false });
  const headers = ['Stop Number', 'Time', 'Stop Location', 'Student Name', 'Contact Name', 'Phone Number', 'Other Equipment', 'Latitude', 'Longitude'];
  const values = [headers];
  for (let i = 0; i < route.stops.length; i++) {
    const s = route.stops[i];
    const students = Array.isArray(s.students) ? s.students : [];
    const lat = s.latitude != null ? String(s.latitude) : '';
    const lng = s.longitude != null ? String(s.longitude) : '';
    if (!students.length) {
      values.push([String(i + 1), s.time || '', s.location || '', '', '', '', '', lat, lng]);
      continue;
    }
    for (let j = 0; j < students.length; j++) {
      const st = students[j] || {};
      values.push([String(i + 1), s.time || '', s.location || '', st.name || '', st.contactName || '', st.phoneNumber || '', st.otherEquipment || '', lat, lng]);
    }
  }
  sh.getRange(1, 1, values.length, headers.length).setValues(values);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
  return ss.getUrl();
}

/** ========== STATE / LOGGING ========== **/
function loadStateV4_() {
  const root = DriveApp.getFolderById(OUTPUT_ROOT_FOLDER_ID_V4);
  const it = root.getFilesByName(STATE_FILE_NAME_V4);
  if (!it.hasNext()) return { queue: [], pos: 0, processed: {}, geocodeCache: {} };
  try {
    const parsed = JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
    return {
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      pos: Number(parsed.pos || 0),
      processed: parsed.processed || {},
      geocodeCache: parsed.geocodeCache || {}
    };
  } catch (_err) {
    return { queue: [], pos: 0, processed: {}, geocodeCache: {} };
  }
}

function saveStateV4_(state) {
  const root = DriveApp.getFolderById(OUTPUT_ROOT_FOLDER_ID_V4);
  const it = root.getFilesByName(STATE_FILE_NAME_V4);
  const payload = JSON.stringify(state);
  if (it.hasNext()) it.next().setContent(payload);
  else root.createFile(STATE_FILE_NAME_V4, payload, MimeType.PLAIN_TEXT);
}

function appendLogsV4_(root, lines) {
  if (!lines || !lines.length) return;
  let ss;
  const it = root.getFilesByName(LOG_SHEET_NAME_V4);
  if (it.hasNext()) ss = SpreadsheetApp.openById(it.next().getId());
  else {
    ss = SpreadsheetApp.create(LOG_SHEET_NAME_V4);
    DriveApp.getFileById(ss.getId()).moveTo(root);
  }
  const sh = ss.getActiveSheet();
  const rows = lines.map(function(l) { return [new Date(), l]; });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
}

/** ========== TRIGGERS ========== **/
function clearPendingUnifiedV4Triggers() { removeTriggersV4_(); }
function scheduleNextV4_() {
  removeTriggersV4_();
  ScriptApp.newTrigger('syncRoutesUnifiedV4').timeBased().after(60 * 1000).create();
}
function removeTriggersV4_() {
  const all = ScriptApp.getProjectTriggers();
  for (let i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === 'syncRoutesUnifiedV4') ScriptApp.deleteTrigger(all[i]);
  }
}

/** ========== MISC HELPERS ========== **/
function getSubfolderByNameV4_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function getOrCreateSubfolderV4_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function isRecentV4_(updated, created, cutoff) {
  return (updated && updated >= cutoff) || (created && created >= cutoff);
}
function stripExtV4_(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? String(name).slice(0, i) : String(name || '');
}
function extractBusNumberV4_(name) {
  const m = String(name || '').match(/\b(\d{1,4})\b/);
  return m ? normalizeBusV4_(m[1]) : '';
}
function inferSchoolNameV4_(name) {
  return stripExtV4_(name).replace(/^\s*\d{1,4}\s+/, '').trim();
}
function normalizeBusV4_(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 1) return `00${d}`;
  if (d.length === 2) return `0${d}`;
  return d;
}
function normalizeWsV4_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function cleanLocationV4_(s) {
  return normalizeWsV4_(s).replace(/^[-:,\s]+/, '').replace(/\s+[-:,\s]+$/, '');
}
function normalizeTimeV4_(t) {
  const s = normalizeWsV4_(t).toUpperCase();
  if (!s) return '';
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return s;
  return `${m[1]}:${m[2] || '00'}${m[3] ? ` ${m[3]}` : ''}`.trim();
}
function parseTimeMinsV4_(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(String(s || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10), min = parseInt(m[2] || '0', 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 11) return h * 60 + min;
  return h * 60 + min;
}
function periodFromTimeV4_(time) {
  const t = parseTimeMinsV4_(time);
  if (t == null) return 'Route';
  if (t >= 360 && t <= 570) return 'AM';
  if (t > 570 && t < 840) return 'Mid-day';
  if (t >= 840 && t <= 1080) return 'PM';
  return 'Route';
}
function canonicalizeSchoolV4_(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/\b\(?\s*ROUTE\s*\)?/i, '')
    .replace(/\s+\((AM|PM|MID-?DAY)\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function canonicalPeriodV4_(stops, schoolName) {
  let best = null;
  for (let i = 0; i < (stops || []).length; i++) {
    const t = parseTimeMinsV4_(stops[i].time);
    if (t == null) continue;
    if (best == null || t < best) best = t;
  }
  if (best != null) {
    if (best >= 360 && best <= 570) return 'AM';
    if (best > 570 && best < 840) return 'Mid-day';
    if (best >= 840 && best <= 1080) return 'PM';
  }
  const up = String(schoolName || '').toUpperCase();
  if (/\bAM\b/.test(up)) return 'AM';
  if (/\bPM\b/.test(up)) return 'PM';
  if (/\bMID[-\s]?DAY\b/.test(up)) return 'Mid-day';
  return 'Route';
}
function canonicalRouteFileStemV4_(schoolName, stops) {
  return `${canonicalizeSchoolV4_(schoolName)} (${canonicalPeriodV4_(stops, schoolName)})`;
}
function errTextV4_(e) { return e && e.message ? e.message : String(e); }
function withRetryV4_(fn, attempts, baseMs) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try { return fn(); } catch (err) {
      lastErr = err;
      if (i >= attempts - 1) break;
      Utilities.sleep(baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200));
    }
  }
  throw lastErr;
}
