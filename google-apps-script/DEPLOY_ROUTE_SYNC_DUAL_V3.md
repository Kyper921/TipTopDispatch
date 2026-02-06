# Deploy Route Sync Dual V3

## What this script matches
Drive structure:
- `Routes/RegEd` (Google Docs)
- `Routes/SpecEd/<bus folder>` (PDF files)

Output:
- `OUTPUT_ROOT/Bus Stops/<bus>/<SCHOOL (PERIOD).json>`

The app in this repo already supports loading JSON route files.

## 1. Add script
1. Open [script.google.com](https://script.google.com)
2. Create project
3. Paste:
   - `/Users/dylanpool/Desktop/Dispatch/google-apps-script/route_sync_dual_v3.gs`

## 2. Configure constants
In the script, set:
- `ROUTES_ROOT_FOLDER_ID` = ID of your `Routes` folder
- `OUTPUT_ROOT_FOLDER_ID` = ID of the folder where `Bus Stops` should live (or already lives)

## 3. Script properties
Set script property:
- `GEMINI_API_KEY` = your Gemini API key

## 4. Enable services
In Apps Script project:
1. `Services` -> add `Drive API`
2. `Services` -> add `Docs API`
3. Ensure `Maps` service is available

In linked Google Cloud project, enable:
- Google Drive API
- Google Docs API
- Generative Language API
- Maps Geocoding/required Maps API

## 5. First run sequence
1. Run `resetRouteSyncDualV3()`
2. Run `rebuildQueueOnlyDualV3()`
3. Run `routeSyncDualV3()`

Then check:
- `OUTPUT_ROOT/Bus Stops/<bus>/...json`
- `OUTPUT_ROOT/Logs` sheet for warnings/errors

## 6. Suggested trigger
Create time trigger for `routeSyncDualV3` every 10-15 minutes.
The script also self-schedules continuation runs until queue completion.

## 7. Tuning knobs
- `RECENT_DAYS_V3`: increase if many files are older but still valid updates.
- `BATCH_SIZE_V3`: increase slowly (start 5-8) to avoid timeouts.

## 8. Expected behavior differences by source
- RegEd docs:
  - Reads **red text lines only**.
  - Uses deterministic parser first (no Gemini cost).
- SpecEd PDFs:
  - OCR + Gemini extraction.
  - More expensive and less deterministic than RegEd.

## 9. If only a few routes update
Check:
1. `RECENT_DAYS_V3` is too low.
2. Files were not actually updated in Drive metadata.
3. Queue exhausted mid-run due to `BATCH_SIZE_V3`.
4. Parse warnings in `Logs` for specific files.
