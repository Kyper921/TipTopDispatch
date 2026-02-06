/** ================================
 * Route Sync Dual V3 (RegEd + SpecEd)
 * =================================
 * Source layout in Drive:
 *   Routes/
 *     RegEd/                 (Google Docs route sheets)
 *     SpecEd/<bus folder>/   (PDF route sheets)
 *
 * Output layout for map app:
 *   OUTPUT_FOLDER/
 *     Bus Stops/<bus>/       (JSON route files)
 *
 * Notes:
 * - RegEd: parses red text lines from Google Docs via Advanced Docs API.
 * - SpecEd: OCRs PDFs and extracts structured routes via Gemini.
 * - Geocodes stops with cache.
 * - Publishes JSON route artifacts that the app can load directly.
 *
 * Required:
 * - Script property: GEMINI_API_KEY
 * - Advanced services: Drive API + Docs API
 * - Maps service enabled in Apps Script
 */

/** ========== CONFIG ========== **/
const ROUTES_ROOT_FOLDER_ID = 'REPLACE_ROUTES_ROOT_FOLDER_ID';
const OUTPUT_ROOT_FOLDER_ID = 'REPLACE_OUTPUT_ROOT_FOLDER_ID';
const REGED_FOLDER_NAME = 'RegEd';
const SPECED_FOLDER_NAME = 'SpecEd';
const BUS_STOPS_FOLDER_NAME = 'Bus Stops';
const COUNTY_SUFFIX_V3 = ', Howard County, Maryland';
const MODEL_V3 = 'gemini-2.5-flash';

const RECENT_DAYS_V3 = 10;
const BATCH_SIZE_V3 = 5;
const STATE_FILE_NAME_V3 = '_route_sync_dual_v3_state.json';

/** ========== ENTRYPOINTS ========== **/
function routeSyncDualV3() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('routeSyncDualV3: another run is active; skipping.');
    return;
  }

  try {
    const state = loadStateV3_();
    if (!Array.isArray(state.queue) || state.pos >= state.queue.length) {
      rebuildQueueDualV3_(state);
    }

    const outputRoot = DriveApp.getFolderById(OUTPUT_ROOT_FOLDER_ID);
    const busStopsRoot = getOrCreateSubfolderV3_(outputRoot, BUS_STOPS_FOLDER_NAME);
    const end = Math.min(state.pos + BATCH_SIZE_V3, state.queue.length);
    const logs = [];

    for (; state.pos < end; state.pos++) {
      const item = state.queue[state.pos];
      if (!item || !item.fileId || !item.routeType) continue;

      const doneStamp = state.processed[item.fileId];
      if (String(doneStamp || '') === String(item.updatedMs || '')) {
        logs.push(`[SKIP] ${item.routeType} ${item.fileName}: unchanged`);
        continue;
      }

      try {
        if (item.routeType === 'REGED_DOC') {
          const routes = parseRegEdDocToRoutesV3_(item.fileId, item.fileName, item.busNumberHint);
          publishRoutesV3_(routes, item, busStopsRoot, state, logs);
        } else if (item.routeType === 'SPECED_PDF') {
          const text = ocrPdfToTextV3_(item.fileId);
          if (!text) {
            logs.push(`[WARN] SpecEd ${item.fileName}: empty OCR`);
            continue;
          }
          const extracted = extractSpecEdRoutesWithGeminiV3_(text);
          if (!Array.isArray(extracted) || extracted.length === 0) {
            logs.push(`[WARN] SpecEd ${item.fileName}: no routes extracted`);
            continue;
          }
          const routes = extracted.map(function(r) {
            return cleanRouteV3_(r, item.schoolNameHint || stripExtV3_(item.fileName), item.busNumberHint || '');
          });
          publishRoutesV3_(routes, item, busStopsRoot, state, logs);
        } else {
          logs.push(`[WARN] Unknown routeType for ${item.fileName}`);
        }

        state.processed[item.fileId] = String(item.updatedMs || 0);
      } catch (err) {
        logs.push(`[ERROR] ${item.routeType} ${item.fileName}: ${toErrV3_(err)}`);
      }
    }

    appendLogsV3_(outputRoot, logs);

    if (state.pos < state.queue.length) {
      scheduleNextDualV3_();
    } else {
      state.queue = [];
      state.pos = 0;
      removeDualTriggersV3_();
      Logger.log('routeSyncDualV3: queue complete.');
    }

    saveStateV3_(state);
  } finally {
    lock.releaseLock();
  }
}

function rebuildQueueOnlyDualV3() {
  const state = loadStateV3_();
  rebuildQueueDualV3_(state);
  saveStateV3_(state);
}

function resetRouteSyncDualV3() {
  removeDualTriggersV3_();
  saveStateV3_({ queue: [], pos: 0, processed: {}, geocodeCache: {} });
}

/** ========== QUEUE BUILD ========== **/
function rebuildQueueDualV3_(state) {
  const root = DriveApp.getFolderById(ROUTES_ROOT_FOLDER_ID);
  const regEdFolder = getSubfolderByNameV3_(root, REGED_FOLDER_NAME);
  const specEdFolder = getSubfolderByNameV3_(root, SPECED_FOLDER_NAME);
  if (!regEdFolder) throw new Error(`Missing folder "${REGED_FOLDER_NAME}" under Routes root.`);
  if (!specEdFolder) throw new Error(`Missing folder "${SPECED_FOLDER_NAME}" under Routes root.`);

  const cutoff = new Date(Date.now() - RECENT_DAYS_V3 * 24 * 60 * 60 * 1000);
  const queue = [];

  const regFiles = regEdFolder.getFiles();
  while (regFiles.hasNext()) {
    const f = regFiles.next();
    if (f.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
    const updated = f.getLastUpdated();
    const created = f.getDateCreated();
    if (!isRecentV3_(updated, created, cutoff)) continue;

    queue.push({
      routeType: 'REGED_DOC',
      fileId: f.getId(),
      fileName: f.getName(),
      updatedMs: updated ? updated.getTime() : 0,
      busNumberHint: extractBusNumberFromNameV3_(f.getName()),
      schoolNameHint: stripExtV3_(f.getName())
    });
  }

  const busFolders = specEdFolder.getFolders();
  while (busFolders.hasNext()) {
    const busFolder = busFolders.next();
    const busNumber = normalizeBusV3_(busFolder.getName());
    const files = busFolder.getFiles();

    while (files.hasNext()) {
      const f = files.next();
      if (f.getMimeType() !== MimeType.PDF) continue;
      const updated = f.getLastUpdated();
      const created = f.getDateCreated();
      if (!isRecentV3_(updated, created, cutoff)) continue;

      queue.push({
        routeType: 'SPECED_PDF',
        fileId: f.getId(),
        fileName: f.getName(),
        updatedMs: updated ? updated.getTime() : 0,
        busNumberHint: busNumber || extractBusNumberFromNameV3_(f.getName()),
        schoolNameHint: stripExtV3_(f.getName())
      });
    }
  }

  queue.sort(function(a, b) {
    return Number(b.updatedMs || 0) - Number(a.updatedMs || 0);
  });

  state.queue = queue;
  state.pos = 0;
  Logger.log(`rebuildQueueDualV3_: queued ${queue.length} files.`);
}

/** ========== REGED DOC PARSER ========== **/
function parseRegEdDocToRoutesV3_(docId, docName, busHint) {
  const doc = withRetryV3_(function() { return Docs.Documents.get(docId); }, 3, 400);
  const lines = extractRedParagraphLinesV3_(doc);
  if (!lines.length) return [];

  const busNumber = normalizeBusV3_(busHint || extractBusNumberFromNameV3_(docName));
  const schoolName = inferSchoolNameFromDocNameV3_(docName);
  const parsedStops = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = normalizeWhitespaceV3_(lines[i]);
    const stop = parseRegEdStopLineV3_(raw);
    if (stop) parsedStops.push(stop);
  }

  if (!parsedStops.length) return [];

  const grouped = splitStopsByPeriodV3_(parsedStops);
  const routes = [];
  for (const periodName in grouped) {
    const stops = grouped[periodName];
    if (!stops || !stops.length) continue;
    routes.push({
      busNumber: busNumber || 'N/A',
      schoolName: schoolName,
      period: periodName,
      stops: stops.map(function(s) {
        return { time: s.time || '', location: s.location || '', students: [] };
      })
    });
  }

  if (!routes.length) {
    routes.push({
      busNumber: busNumber || 'N/A',
      schoolName: schoolName,
      period: 'Route',
      stops: parsedStops.map(function(s) { return { time: s.time || '', location: s.location || '', students: [] }; })
    });
  }

  return routes;
}

function extractRedParagraphLinesV3_(doc) {
  const out = [];
  const body = doc && doc.body && doc.body.content ? doc.body.content : [];
  for (let i = 0; i < body.length; i++) {
    const para = body[i].paragraph;
    if (!para || !Array.isArray(para.elements)) continue;

    let paraText = '';
    let hasRed = false;
    for (let j = 0; j < para.elements.length; j++) {
      const el = para.elements[j];
      const tr = el && el.textRun;
      if (!tr || !tr.content) continue;
      paraText += tr.content;
      if (isTextStyleRedV3_(tr.textStyle)) hasRed = true;
    }

    if (hasRed) {
      const line = normalizeWhitespaceV3_(paraText);
      if (line) out.push(line);
    }
  }
  return out;
}

function isTextStyleRedV3_(style) {
  const c = style && style.foregroundColor && style.foregroundColor.color &&
    style.foregroundColor.color.rgbColor;
  if (!c) return false;
  const r = Number(c.red || 0);
  const g = Number(c.green || 0);
  const b = Number(c.blue || 0);
  return r >= 0.7 && g <= 0.25 && b <= 0.25;
}

function parseRegEdStopLineV3_(line) {
  if (!line) return null;
  const upper = line.toUpperCase();

  // Skip route maneuver instructions.
  if (/^(LEFT|RIGHT|TURN|PROCEED|CONTINUE|BUS\s+\d+)/.test(upper)) return null;
  if (/^\(?\d+\s*(ST|ND|RD|TH)\b/.test(upper)) return null;

  // Accept optional time prefix.
  const m = line.match(/^(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s+(.+)$/i);
  if (m) {
    const time = normalizeTimeV3_(m[1]);
    const location = cleanLocationV3_(m[2]);
    if (!location) return null;
    return { time: time, location: location };
  }

  // If no time, still keep as location if it looks like an address/intersection.
  if (looksLikeStopLocationV3_(line)) {
    return { time: '', location: cleanLocationV3_(line) };
  }
  return null;
}

function looksLikeStopLocationV3_(line) {
  const up = line.toUpperCase();
  if (up.length < 6) return false;
  if (/[A-Z]/.test(up) === false) return false;
  return /\d/.test(up) || up.indexOf('/') >= 0 || /\b(ROAD|RD|STREET|ST|AVENUE|AVE|DRIVE|DR|COURT|CT|WAY|LANE|LN|PLACE|PL|CIRCLE|CIR|PKWY|PARKWAY)\b/.test(up);
}

function normalizeTimeV3_(timeText) {
  const t = normalizeWhitespaceV3_(timeText).toUpperCase();
  if (!t) return '';
  if (/\b(AM|PM)\b/.test(t)) return t;
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return t;
  // RegEd docs often omit AM/PM; keep raw clock without forcing AM/PM.
  return (m[1] + ':' + (m[2] || '00'));
}

function cleanLocationV3_(s) {
  return normalizeWhitespaceV3_(String(s || ''))
    .replace(/^[-:,\s]+/, '')
    .replace(/\s+[-:,\s]+$/, '');
}

function splitStopsByPeriodV3_(stops) {
  const out = { AM: [], PM: [], 'Mid-day': [], Route: [] };
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const p = determinePeriodFromStopTimeV3_(stop.time);
    out[p].push(stop);
  }

  // If AM/PM were not inferable from times, keep in Route.
  if (out.AM.length + out.PM.length + out['Mid-day'].length === 0) {
    out.Route = stops.slice();
  }
  return out;
}

function determinePeriodFromStopTimeV3_(timeText) {
  const mins = parseTimeToMinutesV3_(timeText);
  if (mins == null) return 'Route';
  if (mins >= 360 && mins <= 570) return 'AM';
  if (mins > 570 && mins < 840) return 'Mid-day';
  if (mins >= 840 && mins <= 1080) return 'PM';
  return 'Route';
}

/** ========== SPECED OCR + AI ========== **/
function ocrPdfToTextV3_(fileId) {
  return withRetryV3_(function() {
    const copied = Drive.Files.copy(
      { mimeType: 'application/vnd.google-apps.document', title: `tmp-ocr ${new Date().toISOString()}` },
      fileId,
      { ocr: true, ocrLanguage: 'en' }
    );
    const docId = copied.id;
    try {
      const text = DocumentApp.openById(docId).getBody().getText();
      return text ? text.trim() : '';
    } finally {
      Drive.Files.trash(docId);
    }
  }, 3, 500);
}

function extractSpecEdRoutesWithGeminiV3_(text) {
  return withRetryV3_(function() {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY script property');

    const prompt = [
      'Return ONLY a JSON array. No prose.',
      '',
      'interface Student { name: string; contactName?: string; phoneNumber?: string; otherEquipment?: string; }',
      'interface StopTime { time: string; location: string; students: Student[]; }',
      'interface BusRoute { busNumber: string; schoolName: string; stops: StopTime[]; }',
      '',
      'Rules:',
      '- Do NOT include the school itself as a stop.',
      '- If multiple phone numbers exist, separate with \\n.',
      '- If invalid input, return [].',
      '',
      'TEXT:',
      '---',
      text,
      '---'
    ].join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_V3}:generateContent?key=${encodeURIComponent(apiKey)}`;
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

    if (res.getResponseCode() !== 200) {
      throw new Error(`Gemini API ${res.getResponseCode()}: ${res.getContentText()}`);
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
  }, 3, 1000);
}

/** ========== ROUTE CLEAN + PUBLISH ========== **/
function publishRoutesV3_(routes, item, busStopsRoot, state, logs) {
  if (!Array.isArray(routes) || !routes.length) {
    logs.push(`[WARN] ${item.fileName}: no publishable routes`);
    return;
  }

  const cleaned = routes.map(function(r) {
    return cleanRouteV3_(r, item.schoolNameHint || '', item.busNumberHint || '');
  });
  geocodeAllStopsV3_(cleaned, state);

  for (let i = 0; i < cleaned.length; i++) {
    const route = cleaned[i];
    if (!route.stops || !route.stops.length) continue;
    const busFolder = getOrCreateSubfolderV3_(busStopsRoot, route.busNumber || 'N-A');
    const fileName = canonicalRouteFileNameV3_(route.schoolName, route.stops);
    const artifact = {
      meta: {
        sourceType: item.routeType,
        sourceFileId: item.fileId,
        sourceFileName: item.fileName,
        sourceUpdatedMs: item.updatedMs || 0,
        generatedAt: new Date().toISOString(),
        countyHint: COUNTY_SUFFIX_V3,
        model: item.routeType === 'SPECED_PDF' ? MODEL_V3 : 'deterministic-red-lines'
      },
      busNumber: route.busNumber,
      schoolName: route.schoolName,
      period: canonicalPeriodV3_(route.stops, route.schoolName),
      stops: route.stops
    };

    const url = upsertJsonFileV3_(busFolder, fileName, artifact);
    logs.push(`[OK] ${route.busNumber} ${fileName} -> ${url}`);
  }
}

function cleanRouteV3_(route, fallbackSchool, fallbackBus) {
  let bus = normalizeBusV3_((route && route.busNumber) || fallbackBus || '');
  if (!bus) bus = 'N-A';
  const school = String((route && route.schoolName) || fallbackSchool || '').trim();

  const stops = ((route && route.stops) || [])
    .filter(function(s) {
      if (!s || !s.location) return false;
      const loc = String(s.location).trim();
      if (!loc) return false;
      if (school && loc.toLowerCase() === school.toLowerCase()) return false;
      return true;
    })
    .map(function(s) {
      return {
        time: String(s.time || ''),
        location: cleanLocationV3_(s.location),
        students: Array.isArray(s.students) ? s.students.map(function(st) {
          return {
            name: String((st && st.name) || ''),
            contactName: String((st && st.contactName) || ''),
            phoneNumber: normalizePhonesV3_(String((st && st.phoneNumber) || '')),
            otherEquipment: String((st && st.otherEquipment) || '')
          };
        }) : []
      };
    });

  return {
    busNumber: bus,
    schoolName: school || 'Unknown Route',
    stops: dedupeStopsV3_(stops)
  };
}

function dedupeStopsV3_(stops) {
  const seen = {};
  const out = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const key = (String(s.time || '') + '|' + String(s.location || '')).toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(s);
  }
  return out;
}

/** ========== GEOCODING ========== **/
function geocodeAllStopsV3_(routes, state) {
  if (!state.geocodeCache) state.geocodeCache = {};
  const geocoder = Maps.newGeocoder().setRegion('us');

  for (let r = 0; r < routes.length; r++) {
    const route = routes[r];
    for (let i = 0; i < route.stops.length; i++) {
      const stop = route.stops[i];
      if (!stop.location) continue;
      const query = stop.location + COUNTY_SUFFIX_V3;
      const key = query.toLowerCase();
      const cached = state.geocodeCache[key];
      if (cached && typeof cached.lat === 'number' && typeof cached.lng === 'number') {
        stop.latitude = cached.lat;
        stop.longitude = cached.lng;
        continue;
      }

      const res = withRetryV3_(function() { return geocoder.geocode(query); }, 3, 500);
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

/** ========== DRIVE STATE / FILES ========== **/
function loadStateV3_() {
  const outputRoot = DriveApp.getFolderById(OUTPUT_ROOT_FOLDER_ID);
  const it = outputRoot.getFilesByName(STATE_FILE_NAME_V3);
  if (!it.hasNext()) {
    return { queue: [], pos: 0, processed: {}, geocodeCache: {} };
  }
  try {
    const text = it.next().getBlob().getDataAsString('UTF-8');
    const parsed = JSON.parse(text);
    return {
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      pos: Number(parsed.pos || 0),
      processed: parsed.processed || {},
      geocodeCache: parsed.geocodeCache || {}
    };
  } catch (err) {
    Logger.log(`loadStateV3_ parse error: ${toErrV3_(err)}`);
    return { queue: [], pos: 0, processed: {}, geocodeCache: {} };
  }
}

function saveStateV3_(state) {
  const outputRoot = DriveApp.getFolderById(OUTPUT_ROOT_FOLDER_ID);
  const it = outputRoot.getFilesByName(STATE_FILE_NAME_V3);
  const payload = JSON.stringify(state);
  if (it.hasNext()) {
    it.next().setContent(payload);
  } else {
    outputRoot.createFile(STATE_FILE_NAME_V3, payload, MimeType.PLAIN_TEXT);
  }
}

function upsertJsonFileV3_(folder, fileName, obj) {
  const name = fileName.toLowerCase().endsWith('.json') ? fileName : (fileName + '.json');
  const it = folder.getFilesByName(name);
  const content = JSON.stringify(obj, null, 2);
  let file;
  if (it.hasNext()) {
    file = it.next();
    file.setContent(content);
  } else {
    file = folder.createFile(name, content, MimeType.PLAIN_TEXT);
  }
  return `https://drive.google.com/file/d/${file.getId()}/view`;
}

function getSubfolderByNameV3_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

function getOrCreateSubfolderV3_(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

/** ========== TRIGGERS ========== **/
function clearPendingDualV3Triggers() {
  removeDualTriggersV3_();
}

function scheduleNextDualV3_() {
  removeDualTriggersV3_();
  ScriptApp.newTrigger('routeSyncDualV3').timeBased().after(60 * 1000).create();
}

function removeDualTriggersV3_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    if (t.getHandlerFunction() === 'routeSyncDualV3') {
      ScriptApp.deleteTrigger(t);
    }
  }
}

/** ========== LOGGING ========== **/
function appendLogsV3_(destRoot, lines) {
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

/** ========== NAMING / PERIOD ========== **/
function canonicalRouteFileNameV3_(schoolName, stops) {
  const school = canonicalizeSchoolV3_(schoolName);
  const period = canonicalPeriodV3_(stops, schoolName);
  return `${school} (${period}).json`;
}

function canonicalizeSchoolV3_(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)\b/i, '')
    .replace(/\b\(?\s*ROUTE\s*\)?/i, '')
    .replace(/\s+\((AM|PM|MID-?DAY)\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalPeriodV3_(stops, schoolName) {
  const p = determinePeriodV3_(stops);
  if (p !== 'Route') return p;
  const up = String(schoolName || '').toUpperCase();
  if (/\bAM\b/.test(up)) return 'AM';
  if (/\bPM\b/.test(up)) return 'PM';
  if (/\bMID[-\s]?DAY\b/.test(up)) return 'Mid-day';
  return 'Route';
}

function determinePeriodV3_(stops) {
  if (!Array.isArray(stops) || !stops.length) return 'Route';
  let best = null;
  for (let i = 0; i < stops.length; i++) {
    const t = parseTimeToMinutesV3_(stops[i] && stops[i].time);
    if (t == null) continue;
    if (best == null || t < best) best = t;
  }
  if (best == null) return 'Route';
  if (best >= 360 && best <= 570) return 'AM';
  if (best >= 840 && best <= 1080) return 'PM';
  if (best > 570 && best < 840) return 'Mid-day';
  return 'Route';
}

function parseTimeToMinutesV3_(s) {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(String(s).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  const ap = m[3] ? m[3].toUpperCase() : '';
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (!ap) {
    // Ambiguous bare times in route docs are usually morning.
    if (h >= 1 && h <= 11) return h * 60 + min;
  }
  return h * 60 + min;
}

/** ========== GENERIC HELPERS ========== **/
function isRecentV3_(updated, created, cutoff) {
  return (updated && updated >= cutoff) || (created && created >= cutoff);
}

function normalizeBusV3_(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 1) return '00' + digits;
  if (digits.length === 2) return '0' + digits;
  return digits;
}

function extractBusNumberFromNameV3_(name) {
  const m = String(name || '').match(/\b(\d{1,4})\b/);
  return m ? normalizeBusV3_(m[1]) : '';
}

function inferSchoolNameFromDocNameV3_(name) {
  const n = stripExtV3_(name);
  return n.replace(/^\s*\d{1,4}\s+/, '').trim() || n.trim();
}

function normalizeWhitespaceV3_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripExtV3_(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : String(name || '');
}

function normalizePhonesV3_(raw) {
  if (!raw) return '';
  const seen = {};
  return String(raw).split('\n')
    .map(function(s) { return s.replace(/[^\dxX]/g, ''); })
    .map(function(s) { return s.length === 11 && s.charAt(0) === '1' ? s.slice(1) : s; })
    .map(function(s) { return s.length >= 10 ? (s.slice(0, 3) + '-' + s.slice(3, 6) + '-' + s.slice(6, 10)) : s; })
    .filter(function(s) {
      if (!s) return false;
      if (seen[s]) return false;
      seen[s] = true;
      return true;
    })
    .join('\n');
}

function toErrV3_(err) {
  return err && err.message ? err.message : String(err);
}

function withRetryV3_(fn, attempts, baseMs) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (i >= attempts - 1) break;
      const waitMs = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      Utilities.sleep(waitMs);
    }
  }
  throw lastErr;
}
