/** =========================
 * Route Sync V2 (Low Cost)
 * =========================
 * What this does:
 * - Reads route PDFs from SOURCE_FOLDER_ID (bus subfolders).
 * - OCRs + extracts structured route data with Gemini.
 * - Geocodes stop locations (cached).
 * - Writes one JSON route artifact per route into DEST_FOLDER_ID/busFolder.
 *
 * Why this version:
 * - Uses lock to prevent overlapping runs.
 * - Retries external calls with backoff.
 * - Skips unchanged PDFs based on last-updated timestamp.
 * - Stores state in one JSON file (not large script properties blobs).
 *
 * Required setup:
 * - Script property: GEMINI_API_KEY
 * - Enable Advanced Drive API (Services -> Drive API)
 * - Enable Maps Service in Apps Script project
 */

/** ========== CONFIG ========== **/
const SOURCE_FOLDER_ID = 'REPLACE_SOURCE_FOLDER_ID';
const DEST_FOLDER_ID = 'REPLACE_DEST_FOLDER_ID';
const COUNTY_SUFFIX = ', Howard County, Maryland';
const MODEL = 'gemini-2.5-flash';

const RECENT_DAYS = 7;
const BATCH_SIZE = 4;
const STATE_FILE_NAME = '_route_sync_state_v2.json';
const JSON_EXT = '.json';
const ENABLE_SHEETS_OUTPUT = false;

/** ========== ENTRYPOINTS ========== **/
function routeSyncV2() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('routeSyncV2: another run is active. Skipping.');
    return;
  }

  try {
    const state = loadState_();
    const now = new Date();
    if (!Array.isArray(state.queue) || state.pos >= state.queue.length) {
      buildQueueV2_(state, now);
    }

    const destRoot = DriveApp.getFolderById(DEST_FOLDER_ID);
    const end = Math.min(state.pos + BATCH_SIZE, state.queue.length);
    const logs = [];

    for (; state.pos < end; state.pos++) {
      const item = state.queue[state.pos];
      if (!item || !item.pdfId) continue;

      const fingerprint = `${item.pdfId}:${item.pdfUpdatedMs || 0}`;
      const lastDone = state.processed[item.pdfId];
      if (lastDone && String(lastDone) === String(item.pdfUpdatedMs || 0)) {
        logs.push(`[SKIP] ${item.busNumber} ${item.school}: unchanged`);
        continue;
      }

      try {
        const text = ocrPdfToTextWithRetry_(item.pdfId);
        if (!text) {
          logs.push(`[WARN] ${item.busNumber} ${item.school}: empty OCR`);
          continue;
        }

        const routes = extractRoutesWithGeminiWithRetry_(text);
        if (!Array.isArray(routes) || routes.length === 0) {
          logs.push(`[WARN] ${item.busNumber} ${item.school}: no routes extracted`);
          continue;
        }

        const cleaned = routes.map(r => cleanRoute_(r, item.school, item.busNumber));
        const geocoded = geocodeAllStopsCached_(cleaned, state);
        const busFolder = getOrCreateSubfolder_(destRoot, item.busNumber);

        for (const route of geocoded) {
          const fileName = canonicalRouteFileName_(route.schoolName, route.stops);
          const artifact = {
            meta: {
              sourcePdfId: item.pdfId,
              sourcePdfName: item.pdfName || '',
              sourceFingerprint: fingerprint,
              createdAt: new Date().toISOString(),
              model: MODEL
            },
            busNumber: route.busNumber,
            schoolName: route.schoolName,
            period: canonicalPeriod_(route.stops, route.schoolName),
            stops: route.stops
          };

          const url = upsertJsonFile_(busFolder, fileName, artifact);
          logs.push(`[OK] ${route.busNumber} ${fileName} -> ${url}`);

          if (ENABLE_SHEETS_OUTPUT) {
            upsertSheetFromRoute_(busFolder, route);
          }
        }

        state.processed[item.pdfId] = String(item.pdfUpdatedMs || 0);
      } catch (err) {
        logs.push(`[ERROR] ${item.busNumber} ${item.school}: ${toError_(err)}`);
      }
    }

    appendLogs_(destRoot, logs);

    if (state.pos < state.queue.length) {
      scheduleNextRunV2_();
    } else {
      state.queue = [];
      state.pos = 0;
      removeSyncTriggersV2_();
      Logger.log('routeSyncV2: queue complete.');
    }

    saveState_(state);
  } finally {
    lock.releaseLock();
  }
}

function resetRouteSyncV2() {
  removeSyncTriggersV2_();
  saveState_({ queue: [], pos: 0, processed: {}, geocodeCache: {} });
}

/** ========== QUEUE ========== **/
function buildQueueOnlyV2() {
  const state = loadState_();
  buildQueueV2_(state, new Date());
  saveState_(state);
}

function buildQueueV2_(state, now) {
  const cutoff = new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const srcRoot = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  const queue = [];

  const busFolders = srcRoot.getFolders();
  while (busFolders.hasNext()) {
    const busFolder = busFolders.next();
    const busNumber = normalizeBus_(busFolder.getName());
    const files = busFolder.getFiles();

    while (files.hasNext()) {
      const f = files.next();
      if (f.getMimeType() !== MimeType.PDF) continue;
      const updated = f.getLastUpdated();
      const created = f.getDateCreated();
      const isRecent = (updated && updated >= cutoff) || (created && created >= cutoff);
      if (!isRecent) continue;

      queue.push({
        pdfId: f.getId(),
        pdfName: f.getName(),
        school: stripExt_(f.getName()).trim(),
        busNumber: busNumber,
        pdfUpdatedMs: updated ? updated.getTime() : 0
      });
    }
  }

  state.queue = queue;
  state.pos = 0;
  Logger.log(`buildQueueV2_: queued ${queue.length} PDFs since ${cutoff.toISOString()}`);
}

/** ========== STATE FILE ========== **/
function loadState_() {
  const root = DriveApp.getFolderById(DEST_FOLDER_ID);
  const it = root.getFilesByName(STATE_FILE_NAME);
  if (!it.hasNext()) {
    const initial = { queue: [], pos: 0, processed: {}, geocodeCache: {} };
    const file = root.createFile(STATE_FILE_NAME, JSON.stringify(initial), MimeType.PLAIN_TEXT);
    return initial;
  }
  const file = it.next();
  try {
    const text = file.getBlob().getDataAsString('UTF-8');
    const parsed = JSON.parse(text);
    return {
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      pos: Number(parsed.pos || 0),
      processed: parsed.processed || {},
      geocodeCache: parsed.geocodeCache || {}
    };
  } catch (err) {
    Logger.log(`loadState_ parse error, resetting state: ${toError_(err)}`);
    return { queue: [], pos: 0, processed: {}, geocodeCache: {} };
  }
}

function saveState_(state) {
  const root = DriveApp.getFolderById(DEST_FOLDER_ID);
  const it = root.getFilesByName(STATE_FILE_NAME);
  const payload = JSON.stringify(state);
  if (it.hasNext()) {
    it.next().setContent(payload);
  } else {
    root.createFile(STATE_FILE_NAME, payload, MimeType.PLAIN_TEXT);
  }
}

/** ========== TRIGGERS ========== **/
function clearPendingSyncTriggersV2() {
  removeSyncTriggersV2_();
}

function scheduleNextRunV2_() {
  removeSyncTriggersV2_();
  ScriptApp.newTrigger('routeSyncV2').timeBased().after(60 * 1000).create();
}

function removeSyncTriggersV2_() {
  const all = ScriptApp.getProjectTriggers();
  for (const t of all) {
    if (t.getHandlerFunction() === 'routeSyncV2') {
      ScriptApp.deleteTrigger(t);
    }
  }
}

/** ========== OCR ========== **/
function ocrPdfToTextWithRetry_(fileId) {
  return withRetry_(function() {
    const copied = Drive.Files.copy(
      { mimeType: 'application/vnd.google-apps.document', title: `tmp-ocr ${new Date().toISOString()}` },
      fileId,
      { ocr: true, ocrLanguage: 'en' }
    );
    const docId = copied.id;
    try {
      const txt = DocumentApp.openById(docId).getBody().getText();
      return (txt || '').trim();
    } finally {
      Drive.Files.trash(docId);
    }
  }, 3, 500);
}

/** ========== GEMINI EXTRACTION ========== **/
function extractRoutesWithGeminiWithRetry_(text) {
  return withRetry_(function() {
    return extractRoutesWithGemini_(text);
  }, 3, 1000);
}

function extractRoutesWithGemini_(text) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY script property');

  const prompt = [
    'Return ONLY a JSON array. No prose.',
    '',
    'interface Student { name: string; contactName?: string; phoneNumber?: string; otherEquipment?: string; }',
    'interface StopTime { time: string; location: string; latitude?: number; longitude?: number; students: Student[]; }',
    'interface BusRoute { busNumber: string; schoolName: string; stops: StopTime[]; }',
    '',
    'Rules:',
    '- Do NOT include the school itself as a stop.',
    '- Keep times as they appear (e.g., 6:42 AM).',
    '- If invalid or empty input, return [].',
    '',
    'TEXT:',
    '---',
    text,
    '---'
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
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

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(`Gemini API ${code}: ${res.getContentText()}`);
  }

  const body = JSON.parse(res.getContentText());
  const txt = body && body.candidates && body.candidates[0] && body.candidates[0].content &&
    body.candidates[0].content.parts && body.candidates[0].content.parts[0] &&
    body.candidates[0].content.parts[0].text;
  if (!txt) return [];

  try {
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

/** ========== CLEAN / NORMALIZE ========== **/
function cleanRoute_(route, fallbackSchool, fallbackBus) {
  let bus = normalizeBus_(route && route.busNumber ? route.busNumber : fallbackBus);
  const school = String(route && route.schoolName ? route.schoolName : fallbackSchool || '').trim();

  const stops = (route && Array.isArray(route.stops) ? route.stops : [])
    .filter(function(s) {
      return s && s.location && school && String(s.location).trim().toLowerCase() !== school.toLowerCase();
    })
    .map(function(s) {
      return {
        time: String(s.time || ''),
        location: String(s.location || ''),
        students: (Array.isArray(s.students) ? s.students : []).map(function(st) {
          return {
            name: String(st && st.name || ''),
            contactName: String(st && st.contactName || ''),
            phoneNumber: normalizePhones_(String(st && st.phoneNumber || '')),
            otherEquipment: String(st && st.otherEquipment || '')
          };
        })
      };
    });

  return { busNumber: bus || 'N/A', schoolName: school, stops: stops };
}

function normalizeBus_(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 1) return '00' + digits;
  if (digits.length === 2) return '0' + digits;
  return digits;
}

function normalizePhones_(raw) {
  if (!raw) return '';
  const seen = {};
  return String(raw).split('\n')
    .map(function(s) { return s.trim(); })
    .map(function(s) { return s.replace(/[^\dxX]/g, ''); })
    .map(function(s) { return s.length === 11 && s.charAt(0) === '1' ? s.slice(1) : s; })
    .map(function(s) { return s.length >= 10 ? s.slice(0, 3) + '-' + s.slice(3, 6) + '-' + s.slice(6, 10) : s; })
    .filter(function(s) {
      if (!s) return false;
      if (seen[s]) return false;
      seen[s] = true;
      return true;
    })
    .join('\n');
}

/** ========== GEOCODING (STATE CACHED) ========== **/
function geocodeAllStopsCached_(routes, state) {
  const geocoder = Maps.newGeocoder().setRegion('us');
  state.geocodeCache = state.geocodeCache || {};

  for (const route of routes) {
    for (const stop of route.stops) {
      if (!stop.location) continue;
      const query = String(stop.location).trim() + COUNTY_SUFFIX;
      const key = query.toLowerCase();
      const cached = state.geocodeCache[key];
      if (cached && typeof cached.lat === 'number' && typeof cached.lng === 'number') {
        stop.latitude = cached.lat;
        stop.longitude = cached.lng;
        continue;
      }

      const res = withRetry_(function() { return geocoder.geocode(query); }, 3, 500);
      const loc = res && res.results && res.results[0] && res.results[0].geometry &&
        res.results[0].geometry.location;
      if (loc) {
        stop.latitude = loc.lat;
        stop.longitude = loc.lng;
        state.geocodeCache[key] = { lat: loc.lat, lng: loc.lng };
      } else {
        stop.geocodeError = `No match for "${stop.location}"`;
      }
      Utilities.sleep(200);
    }
  }

  return routes;
}

/** ========== JSON OUTPUT ========== **/
function upsertJsonFile_(folder, fileName, obj) {
  const name = fileName.endsWith(JSON_EXT) ? fileName : fileName + JSON_EXT;
  const payload = JSON.stringify(obj, null, 2);
  const it = folder.getFilesByName(name);
  let file;
  if (it.hasNext()) {
    file = it.next();
    file.setContent(payload);
  } else {
    file = folder.createFile(name, payload, MimeType.PLAIN_TEXT);
  }
  return `https://drive.google.com/file/d/${file.getId()}/view`;
}

/** ========== OPTIONAL SHEETS OUTPUT ========== **/
function upsertSheetFromRoute_(busFolder, route) {
  const sheetName = canonicalRouteFileName_(route.schoolName, route.stops).replace(/\.json$/i, '');
  const it = busFolder.getFilesByName(sheetName);
  let ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.openById(it.next().getId());
  } else {
    ss = SpreadsheetApp.create(sheetName);
    DriveApp.getFileById(ss.getId()).moveTo(busFolder);
  }

  const sheet = ss.getSheets()[0] || ss.insertSheet();
  sheet.clear({ contentsOnly: false });

  const headers = ['Stop Number', 'Time', 'Stop Location', 'Student Name', 'Contact Name', 'Phone Number', 'Other Equipment', 'Latitude', 'Longitude'];
  const values = [headers];
  for (let i = 0; i < route.stops.length; i++) {
    const stop = route.stops[i];
    const stopNo = String(i + 1);
    const lat = stop.latitude != null ? String(stop.latitude) : '';
    const lng = stop.longitude != null ? String(stop.longitude) : '';
    const students = Array.isArray(stop.students) ? stop.students : [];
    if (students.length) {
      for (const st of students) {
        values.push([stopNo, stop.time || '', stop.location || '', st.name || '', st.contactName || '', st.phoneNumber || '', st.otherEquipment || '', lat, lng]);
      }
    } else {
      values.push([stopNo, stop.time || '', stop.location || '', '', '', '', '', lat, lng]);
    }
  }
  sheet.getRange(1, 1, values.length, headers.length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

/** ========== CANONICAL NAMING ========== **/
function canonicalizeSchool_(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)\b/i, '')
    .replace(/\b\(?\s*ROUTE\s*\)?/i, '')
    .replace(/\s+\((AM|PM|MID-?DAY)\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function determinePeriod_(stops) {
  if (!stops || !stops.length) return 'Route';
  let best = null;
  for (const s of stops) {
    const t = parseTimeToMinutes_(s && s.time);
    if (t == null) continue;
    if (best == null || t < best) best = t;
  }
  if (best == null) return 'Route';
  if (best >= 360 && best <= 570) return 'AM';
  if (best >= 840 && best <= 1080) return 'PM';
  if (best > 570 && best < 840) return 'Mid-day';
  return 'Route';
}

function parseTimeToMinutes_(s) {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(String(s).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function canonicalPeriod_(stops, schoolName) {
  const p = determinePeriod_(stops);
  if (p !== 'Route') return p;
  const up = String(schoolName || '').toUpperCase();
  if (/\bAM\b/.test(up)) return 'AM';
  if (/\bPM\b/.test(up)) return 'PM';
  if (/\bMID[-\s]?DAY\b/.test(up)) return 'Mid-day';
  return 'Route';
}

function canonicalRouteFileName_(schoolName, stops) {
  const school = canonicalizeSchool_(schoolName);
  const period = canonicalPeriod_(stops, schoolName);
  return `${school} (${period})${JSON_EXT}`;
}

/** ========== UTILITIES ========== **/
function getOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function stripExt_(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : name;
}

function toError_(err) {
  if (err && err.message) return err.message;
  return String(err);
}

function withRetry_(fn, attempts, baseMs) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (i >= attempts - 1) break;
      const sleepMs = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 250);
      Utilities.sleep(sleepMs);
    }
  }
  throw lastErr;
}

function appendLogs_(destRoot, lines) {
  if (!lines || !lines.length) return;
  const name = 'Logs';
  let ss;
  const it = destRoot.getFilesByName(name);
  if (it.hasNext()) {
    ss = SpreadsheetApp.openById(it.next().getId());
  } else {
    ss = SpreadsheetApp.create(name);
    DriveApp.getFileById(ss.getId()).moveTo(destRoot);
  }
  const sh = ss.getActiveSheet();
  const rows = lines.map(function(line) { return [new Date(), line]; });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
}
