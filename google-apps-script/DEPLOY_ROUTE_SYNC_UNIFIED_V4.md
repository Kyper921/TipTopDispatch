# Deploy Route Sync Unified V4

## Script
Use:
- `/Users/dylanpool/Desktop/Dispatch/google-apps-script/route_sync_unified_v4.gs`

## Folder assumptions
- `Routes/RegEd` contains Google Docs routes.
- `Routes/SpecEd/<bus>` contains PDF routes.
- Output writes to `OUTPUT_ROOT/Bus Stops/<bus>`.

## Setup
1. Set constants:
- `ROUTES_ROOT_FOLDER_ID_V4`
- `OUTPUT_ROOT_FOLDER_ID_V4`
2. Set script property:
- `GEMINI_API_KEY`
3. Enable Advanced Services:
- Drive API
- Docs API
4. Ensure Maps service is enabled.

## First run
1. `resetRouteSyncUnifiedV4()`
2. `rebuildQueueOnlyV4()`
3. `syncRoutesUnifiedV4()`

## Important cutover step
Disable old triggers/functions from prior scripts, then keep only `syncRoutesUnifiedV4` scheduled.

## Suggested schedule
Run every 10-15 minutes.

## Tuning
- `RECENT_DAYS_V4`: widen if you miss updates.
- `BATCH_SIZE_V4`: increase slowly (6 -> 8 -> 10) if runtime allows.
- `WRITE_SHEETS_V4`: set `false` for JSON-only output.
