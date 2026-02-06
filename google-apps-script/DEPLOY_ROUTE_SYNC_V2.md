# Deploy Route Sync V2

## 1. Create script project
1. Open [script.google.com](https://script.google.com).
2. Create a new project.
3. Paste `/Users/dylanpool/Desktop/Dispatch/google-apps-script/route_sync_v2.gs`.

## 2. Configure constants
In `route_sync_v2.gs`, set:
- `SOURCE_FOLDER_ID` = Drive folder containing bus subfolders + route PDFs.
- `DEST_FOLDER_ID` = your app route folder root (where bus folders live/read from).

## 3. Set API key
1. In Apps Script, open `Project Settings`.
2. Add script property:
   - key: `GEMINI_API_KEY`
   - value: your API key

## 4. Enable services
1. `Services` -> add `Drive API` (Advanced Google service).
2. Ensure Apps Script `Maps` service is enabled.
3. In Google Cloud project, ensure these APIs are enabled:
   - Google Drive API
   - Generative Language API
   - Geocoding/Maps API (or whichever Maps endpoint your script project uses)

## 5. First run
1. Run `resetRouteSyncV2()` once.
2. Run `buildQueueOnlyV2()` to inspect queue creation.
3. Run `routeSyncV2()` manually for first batch.
4. Check Drive output in `DEST_FOLDER_ID/<bus>/` for JSON route files like:
   - `GUILFORD PARK (AM).json`

## 6. Ongoing operation
- Keep a time-driven trigger on `routeSyncV2` (every 5-15 minutes) OR run ad hoc.
- The script self-schedules one-off continuation runs until queue is finished.

## 7. App compatibility
Your app now reads both:
- Google Sheets route files
- JSON route files (`.json`, plus `application/json` or `text/plain`)

JSON can now become source-of-truth; Sheets can remain optional.

## 8. Cost control notes
- `state.processed[pdfId]=lastUpdated` skips unchanged PDFs.
- Geocode results are cached in state.
- Retry/backoff reduces failed paid retries.
- Keep `BATCH_SIZE` small (e.g., 2-6) for stable execution.
