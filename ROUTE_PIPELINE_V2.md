# Route Pipeline V2 (Low Cost)

## Goal
Build a more reliable and cheaper route ingestion flow than "PDF -> OCR -> AI -> Google Sheet".

## Recommended Architecture
1. Keep PDFs in Google Drive as the source documents.
2. Parse PDFs into normalized JSON route artifacts.
3. Store JSON artifacts in the same bus folder (or a sibling `json` folder).
4. Load routes in the app from JSON first, with Sheets as fallback.
5. Keep Sheets optional for operations review/export only.

This repo now supports step 4.

## Why This Is Better
- Lower cost: no mandatory sheet writes for every route update.
- Better reliability: JSON schema is explicit and easier to validate.
- Easier debugging: parse failures and confidence flags can be stored per artifact.
- Safer migration: existing sheet routes still work.

## JSON Artifact Shape
Use one file per route, for example:
- `GUILFORD PARK (AM).json`
- `GUILFORD PARK (PM).json`

Minimal schema:

```json
{
  "busNumber": "021",
  "schoolName": "GUILFORD PARK",
  "period": "AM",
  "stops": [
    {
      "stopNumber": "1",
      "time": "6:42 AM",
      "location": "123 Main St",
      "latitude": 39.12345,
      "longitude": -76.54321,
      "students": [
        {
          "name": "Student Name",
          "contactName": "Parent Name",
          "phoneNumber": "410-555-0100",
          "otherEquipment": ""
        }
      ]
    }
  ]
}
```

The app also accepts:
- top-level arrays of stops
- `{ "routes": [ { "stops": [...] } ] }`
- `lat/lng` keys instead of `latitude/longitude`

## OCR + AI Recommendation
For best quality-per-dollar:
1. OCR: Google Document AI OCR (or keep Drive OCR initially if volume is low).
2. Parsing:
   - deterministic regex/rules for bus number, times, and phone formats
   - LLM only for ambiguous fields and student grouping
3. Geocoding:
   - cache by normalized address
   - flag low-confidence stops for review before publishing

## Cost Controls
- Cache by `pdfId + lastUpdated` so unchanged PDFs are not reprocessed.
- Keep LLM temperature at `0`.
- Trim OCR text before LLM call (drop repeated headers/footers).
- Process in small batches and retry 429/5xx with exponential backoff.

## Migration Plan
1. Keep current script running.
2. Add JSON export in the parser script.
3. Verify app route rendering from JSON on 1-2 buses.
4. Switch app users to JSON-first route files.
5. Optionally stop creating Sheets except for exceptions/review.
