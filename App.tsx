
import React, { useState, useEffect } from 'react';
import MapWrapper from './components/MapWrapper';
import Sidebar from './components/Sidebar';
import { TripData, EventType, VehicleEvent, PathPoint, SearchedLocation, CurrentLocationData, DriveFile, RouteStop, NavigationData } from './types';
import { MenuIcon } from './components/icons/Icons';

// --- Google API Configuration ---
const GOOGLE_API_KEY = 'AIzaSyAuVKdC1rhyUigZxcFq_ThUOjER3Qu_XpQ';
// IMPORTANT: PASTE YOUR Google Drive "Routes" FOLDER ID HERE
const ROUTES_FOLDER_ID: string = '1HxXVpIlQaGQneXqpZU49Wltk-_0Or0gD';

const DISCOVERY_DOCS = [
    "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    "https://sheets.googleapis.com/$discovery/rest?version=v4"
];
const VEHICLE_MARKER_COLORS = ['#facc15', '#22c55e', '#38bdf8', '#f97316', '#e879f9'];

// --- TypeScript Augmentation for Google APIs ---
declare global {
    var gapi: any;
    var google: any;
}

/**
 * Decodes a Google Maps encoded polyline string into an array of lat/lng coordinates.
 */
const decodePolyline = (encoded: string): [number, number][] => {
    let index = 0, len = encoded.length;
    let lat = 0, lng = 0;
    const path = [];

    while (index < len) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += dlng;

        path.push([lat / 1e5, lng / 1e5]);
    }
    return path;
};

/**
 * Converts degrees to a 16-point cardinal direction.
 */
const degreesToCardinal = (deg: number): string => {
    if (isNaN(deg)) {
        return 'N/A';
    }
    const cardinals = [
        'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW', 'N'
    ];
    const index = Math.round((deg % 360) / 22.5);
    return cardinals[index];
};


const getTodayDateString = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

/**
 * Robustly parses a date string from the Zonar API.
 */
const parseZonarDate = (dateString: string): Date => {
    if (!dateString || typeof dateString !== 'string' || dateString.trim() === 'N/A' || dateString.trim() === '') {
        return new Date(NaN);
    }
    const trimmed = dateString.trim();

    if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(:\d{2})?\s[A-Z]{3,4}$/.test(trimmed)) {
        const timezoneStripped = trimmed.replace(/\s[A-Z]{3,4}$/, '');
        const isoLike = timezoneStripped.replace(' ', 'T'); 
        const date = new Date(isoLike);
        if (!isNaN(date.getTime())) return date;
    }

    const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (match) {
        const [_, monthStr, dayStr, yearStr, hourStr, minuteStr, secondStr, period] = match;
        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10) - 1;
        const day = parseInt(dayStr, 10);
        let hour = parseInt(hourStr, 10);
        const minute = parseInt(minuteStr, 10);
        const second = parseInt(secondStr, 10);

        if (period.toUpperCase() === 'PM' && hour < 12) hour += 12;
        if (period.toUpperCase() === 'AM' && hour === 12) hour = 0;
        
        const parsedDate = new Date(year, month, day, hour, minute, second);
        if (!isNaN(parsedDate.getTime())) return parsedDate;
    }

    let date = new Date(trimmed);
    if (!isNaN(date.getTime())) return date;
    
    if (/^\d{10,}$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        const multiplier = trimmed.length === 10 ? 1000 : 1;
        const unixDate = new Date(num * multiplier);
        if (!isNaN(unixDate.getTime())) return unixDate;
    }

    console.warn(`[parseZonarDate] Failed to parse date string: "${dateString}"`);
    return new Date(NaN);
};


const App: React.FC = () => {
  const [tripData, setTripData] = useState<TripData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [fleet, setFleetState] = useState<string>('');
  const [startDate, setStartDateState] = useState<string>(getTodayDateString());
  const [startTime, setStartTime] = useState<string>('05:00');
  const [endDate, setEndDate] = useState<string>(getTodayDateString());
  const [endTime, setEndTime] = useState<string>('10:00');

  const setStartDate = (value: string) => {
    setStartDateState(value);
    setEndDate(value);
  };

  // Address Search State
  const [addressQuery, setAddressQuery] = useState<string>('');
  const [searchedLocation, setSearchedLocation] = useState<SearchedLocation | null>(null);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Current Location State
  const [currentLocation, setCurrentLocation] = useState<CurrentLocationData | null>(null);
  const [trackedCurrentLocations, setTrackedCurrentLocations] = useState<Array<CurrentLocationData & { markerColor: string }>>([]);
  const [trackedVehicleIds, setTrackedVehicleIds] = useState<string[]>(['']);
  const [isFetchingCurrentLocation, setIsFetchingCurrentLocation] = useState<boolean>(false);
  const [currentLocationError, setCurrentLocationError] = useState<string | null>(null);
  
  // LIVE TRACKING STATE
  const [isLiveTracking, setIsLiveTracking] = useState<boolean>(false);
  const [isViewAllMode, setIsViewAllMode] = useState<boolean>(false);

  // ALL VEHICLES STATE
  const [allVehicleLocations, setAllVehicleLocations] = useState<CurrentLocationData[]>([]);
  const [isFetchingAllVehicles, setIsFetchingAllVehicles] = useState<boolean>(false);
  const [allVehiclesError, setAllVehiclesError] = useState<string | null>(null);
  const [cachedVehicleNumbers, setCachedVehicleNumbers] = useState<string[] | null>(null);

  // Event Interaction State
  const [hoveredEventTimestamp, setHoveredEventTimestamp] = useState<number | null>(null);
  const [selectedEventTimestamp, setSelectedEventTimestamp] = useState<number | null>(null);

  // State for mobile sidebar visibility
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Sidebar view state
  const [sidebarView, setSidebarView] = useState<'main' | 'routes'>('main');
  
  // Route fetching and display state
  const [routes, setRoutes] = useState<DriveFile[] | null>(null);
  const [isFetchingRoutes, setIsFetchingRoutes] = useState<boolean>(false);
  const [routesError, setRoutesError] = useState<string | null>(null);

  const [selectedRoute, setSelectedRoute] = useState<DriveFile | null>(null);
  const [selectedRouteStops, setSelectedRouteStops] = useState<RouteStop[] | null>(null);
  const [isFetchingRouteDetails, setIsFetchingRouteDetails] = useState<boolean>(false);
  const [routeDetailsError, setRouteDetailsError] = useState<string | null>(null);
  const [hoveredRouteStopId, setHoveredRouteStopId] = useState<number | null>(null);

  // Google API State
  const [isGapiReady, setIsGapiReady] = useState(false);

  // Navigation State
  const [navigationData, setNavigationData] = useState<NavigationData | null>(null);
  const [isFetchingNavigation, setIsFetchingNavigation] = useState<boolean>(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  
  const setFleet = (value: string) => {
    setFleetState(value);
    setTrackedVehicleIds(prev => {
      const next = [...prev];
      next[0] = value;
      return next;
    });
    if (routesError) setRoutesError(null);
    if (routeDetailsError) setRouteDetailsError(null);
  };

  const handleUpdateTrackedVehicleId = (index: number, value: string) => {
    setTrackedVehicleIds(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    if (index === 0) setFleet(value);
  };

  const handleAddTrackedVehicleId = () => {
    setTrackedVehicleIds(prev => prev.length >= 5 ? prev : [...prev, '']);
  };

  const handleRemoveTrackedVehicleId = (index: number) => {
    if (index === 0) return;
    setTrackedVehicleIds(prev => prev.filter((_, i) => i !== index));
  };

  const clearRouteData = () => {
    setRoutes(null);
    setRoutesError(null);
    setSelectedRoute(null);
    setSelectedRouteStops(null);
    setRouteDetailsError(null);
    setHoveredRouteStopId(null);
  }

  useEffect(() => {
    const gapiScript = document.createElement('script');
    gapiScript.src = 'https://apis.google.com/js/api.js';
    gapiScript.async = true;
    gapiScript.defer = true;
    gapiScript.onload = () => gapi.load('client', initializeGapiClient);
    document.body.appendChild(gapiScript);

    return () => {
        const gapiScriptElement = document.querySelector('script[src="https://apis.google.com/js/api.js"]');
        if (gapiScriptElement) document.body.removeChild(gapiScriptElement);
    }
  }, []);

  const initializeGapiClient = async () => {
    try {
      await gapi.client.init({
        apiKey: GOOGLE_API_KEY,
        discoveryDocs: DISCOVERY_DOCS,
      });
      setIsGapiReady(true);
    } catch(err) {
      console.error("Error initializing GAPI client", err);
      setRoutesError("Could not initialize Google Services. Please check the API Key.");
    }
  };

  const handleFetchData = async () => {
    if (!fleet) {
        setError("Vehicle Number is required.");
        return;
    }
    setSidebarView('main');
    clearRouteData();

    setIsLoading(true);
    setError(null);
    setTripData(null);
    setCurrentLocation(null);
    setTrackedCurrentLocations([]);
    setAllVehicleLocations([]); 
    setIsViewAllMode(false); 
    setSelectedEventTimestamp(null);
    setHoveredEventTimestamp(null);

    const paddedFleet = fleet.length === 2 && /^\d+$/.test(fleet) ? `0${fleet}` : fleet;
    const fullStartDateTime = new Date(`${startDate}T${startTime}`);
    const fullEndDateTime = new Date(`${endDate}T${endTime}`);
    const params = new URLSearchParams({
        operation: 'path',
        target: paddedFleet,
        starttime: Math.floor(fullStartDateTime.getTime() / 1000).toString(),
        endtime: Math.floor(fullEndDateTime.getTime() / 1000).toString(),
        _cb: Date.now().toString()
    });
    const ZONAR_API_URL = `/api/zonar?${params.toString()}`;
    
    try {
        const response = await fetch(ZONAR_API_URL, { cache: 'no-store' });
        const responseText = await response.text();
        if (!response.ok) throw new Error(`Network response was not ok: ${response.status}`);
        const data = JSON.parse(responseText);
        const assetData = data?.pathevents?.assets?.[0];
        if (data.error || !assetData || !assetData.events || assetData.events.length === 0) {
            let errorMsg = data.error?.message || 'No GPS data found.';
            throw new Error(errorMsg);
        }
        const gpsPoints = assetData.events;
        const path: PathPoint[] = gpsPoints.map((p: any) => ({
            lat: parseFloat(p.lat), lng: parseFloat(p.lng), timestamp: parseZonarDate(p.time).getTime(),
            speed: parseFloat(p.speed) || 0, heading: p.heading || 'N/A',
        }));
        let topSpeedPoint: PathPoint | null = path.length > 0 ? path.reduce((max, p) => p.speed > max.speed ? p : max, path[0]) : null;
        const events: VehicleEvent[] = [];
        events.push({ type: EventType.START, timestamp: parseZonarDate(gpsPoints[0].time).getTime(), location: [parseFloat(gpsPoints[0].lat), parseFloat(gpsPoints[0].lng)], details: `Trip started. Speed: ${gpsPoints[0].speed || 0} mph` });
        for (let i = 1; i < gpsPoints.length; i++) {
            const currentReasons = gpsPoints[i].reasons?.split(',') || []; const prevReasons = gpsPoints[i - 1].reasons?.split(',') || [];
            if (currentReasons.includes('9') && !prevReasons.includes('9')) {
                events.push({ type: EventType.STOP, timestamp: parseZonarDate(gpsPoints[i].time).getTime(), location: [parseFloat(gpsPoints[i].lat), parseFloat(gpsPoints[i].lng)], details: 'Vehicle stopped.' });
            }
        }
        events.push({ type: EventType.END, timestamp: parseZonarDate(gpsPoints[gpsPoints.length - 1].time).getTime(), location: [parseFloat(gpsPoints[gpsPoints.length - 1].lat), parseFloat(gpsPoints[gpsPoints.length - 1].lng)], details: `Trip ended. Speed: ${gpsPoints[gpsPoints.length - 1].speed || 0} mph` });
        const newTripData: TripData = {
            vehicleId: paddedFleet, status: 'Completed', path: path, events: events,
            topSpeedEvent: topSpeedPoint ? { speed: topSpeedPoint.speed, timestamp: topSpeedPoint.timestamp, location: [topSpeedPoint.lat, topSpeedPoint.lng] } : undefined,
        };
        setTripData(newTripData);
        if (window.innerWidth < 768) setIsSidebarOpen(false);
    } catch (err: any) {
        setError(`Load Failed: ${err.message}`);
    } finally {
        setIsLoading(false);
    }
  };

  const handleClearTripData = () => {
    setTripData(null);
    setError(null);
    setSelectedEventTimestamp(null);
    setHoveredEventTimestamp(null);
  };

  const handleClearAddressPath = () => {
    setNavigationData(null);
    setSearchedLocation(null);
    setAddressQuery('');
    setSearchError(null);
  };

  const fetchVehicleLocation = async (vehicleId: string): Promise<CurrentLocationData> => {
      const paddedFleet = vehicleId.length === 2 && /^\d+$/.test(vehicleId) ? `0${vehicleId}` : vehicleId;
      const params = new URLSearchParams({
          operation: 'current',
          target: paddedFleet,
          _cb: Date.now().toString()
      });
      const ZONAR_API_URL = `/api/zonar?${params.toString()}`;

      const response = await fetch(ZONAR_API_URL, { cache: 'no-store' }); 
      const responseText = await response.text();
      
      if (!response.ok) throw new Error(`Network response was not ok: ${response.status}`);
      
      const parser = new DOMParser(); 
      const xmlDoc = parser.parseFromString(responseText, "application/xml");
      const assetNode = xmlDoc.querySelector("asset"); 
      if (!assetNode) throw new Error("No asset data found.");
      
      const getValue = (tagName: string) => assetNode.querySelector(tagName)?.textContent || 'N/A';
      const getAttr = (el: string, attr: string) => assetNode.querySelector(el)?.getAttribute(attr) || '';
      
      const headingDegrees = parseFloat(getValue("heading"));
      const timeString = getValue("time");
      const lat = parseFloat(getValue("lat"));
      const lng = parseFloat(getValue("long"));
      const timestamp = parseZonarDate(timeString).getTime();
      
      if (isNaN(lat) || isNaN(lng)) throw new Error("Invalid location data.");

      return {
          lat, lng, timestamp,
          speed: `${getValue("speed")} ${getAttr("speed", "unit")}`.trim(),
          heading: degreesToCardinal(headingDegrees),
          power: getValue("power"),
          fleet: assetNode.getAttribute("fleet") || paddedFleet,
      };
  };

  const handleFetchCurrentLocation = async (vehicleIdsOverride?: string[]) => {
    const sourceVehicleIds = vehicleIdsOverride ?? trackedVehicleIds;
    const requestedVehicleIds = sourceVehicleIds.map(v => v.trim()).filter(v => v !== '');
    if (requestedVehicleIds.length === 0) { setCurrentLocationError("At least one Vehicle Number is required."); return; }
    setIsFetchingCurrentLocation(true); 
    setCurrentLocationError(null);
    setAllVehicleLocations([]);
    setIsViewAllMode(false);
    setAllVehiclesError(null);
    
    try {
        const results = await Promise.all(requestedVehicleIds.map(async (vehicleId, index) => {
            try {
                const data = await fetchVehicleLocation(vehicleId);
                return { ...data, markerColor: VEHICLE_MARKER_COLORS[index] };
            } catch (e) {
                return null;
            }
        }));
        const locations = results.filter((loc): loc is CurrentLocationData & { markerColor: string } => loc !== null);
        if (locations.length === 0) throw new Error("No valid locations found for provided vehicle numbers.");
        setTrackedCurrentLocations(locations);
        setCurrentLocation(locations[0]);
        setFleet(locations[0].fleet);
        if (!isLiveTracking && window.innerWidth < 768) setIsSidebarOpen(false);
    } catch (err: any) {
        setCurrentLocationError(`Locate Failed: ${err.message}`);
    } finally {
        setIsFetchingCurrentLocation(false);
    }
  };

  const handleSelectVehicleAndLocate = (index: number, value: string) => {
      const normalized = value.trim().toUpperCase();
      if (!normalized) return;
      const nextVehicleIds = [...trackedVehicleIds];
      nextVehicleIds[index] = normalized;
      setTrackedVehicleIds(nextVehicleIds);
      if (index === 0) setFleet(normalized);
      handleFetchCurrentLocation(nextVehicleIds);
  };

  const handleClearCurrentLocation = () => { 
      setCurrentLocation(null); 
      setTrackedCurrentLocations([]);
      setCurrentLocationError(null); 
      setIsLiveTracking(false);
      setAllVehicleLocations([]);
      setIsViewAllMode(false);
      setAllVehiclesError(null);
  };

  const fetchVehicleNumbers = async (): Promise<string[]> => {
        if (cachedVehicleNumbers && cachedVehicleNumbers.length > 0) {
            return cachedVehicleNumbers;
        }
        const response = await gapi.client.drive.files.list({
            q: `name='Vehicle List' and mimeType='application/vnd.google-apps.spreadsheet' and '${ROUTES_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, name)',
        });
        const files = response.result.files;
        if (!files || files.length === 0) throw new Error("Could not find 'Vehicle List' Google Sheet.");
        const spreadsheetId = files[0].id;
        const sheetResponse = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId, range: 'A:A', 
        });
        const values = sheetResponse.result.values;
        if (!values || values.length === 0) throw new Error("The Vehicle List sheet is empty.");
        const vehicleNumbers: string[] = values
            .flat()
            .filter((v: any) => v && typeof v === 'string' && v.trim() !== '')
            .map((v: string) => v.trim().toUpperCase())
            .filter((v: string) => /^\d+$/.test(v) || /^V-\d{2}$/.test(v));
        setCachedVehicleNumbers(vehicleNumbers);
        return vehicleNumbers;
  };

  const fetchAllVehiclesList = async (): Promise<CurrentLocationData[]> => {
        const vehicleNumbers = await fetchVehicleNumbers();
        const concurrency = 5;
        const results: Array<CurrentLocationData | null> = [];
        for (let i = 0; i < vehicleNumbers.length; i += concurrency) {
            const batch = vehicleNumbers.slice(i, i + concurrency);
            const batchResults = await Promise.all(batch.map(async (num) => {
                try { return await fetchVehicleLocation(num); } catch (e) { return null; }
            }));
            results.push(...batchResults);
        }
        return results.filter((loc): loc is CurrentLocationData => loc !== null);
  };

  useEffect(() => {
    if (!isGapiReady) return;
    if (cachedVehicleNumbers && cachedVehicleNumbers.length > 0) return;
    fetchVehicleNumbers().catch((err) => {
      console.warn("Vehicle list preload failed:", err);
    });
  }, [isGapiReady, cachedVehicleNumbers]);

  const handleFetchAllVehicles = async (isBackground: boolean = false) => {
    if (!isBackground) setIsFetchingAllVehicles(true);
    setAllVehiclesError(null);
    if (!isBackground) setAllVehicleLocations([]);
    setCurrentLocation(null);
    setIsViewAllMode(true);
    if (!isBackground) setIsLiveTracking(false);
    try {
        const validLocations = await fetchAllVehiclesList();
        setAllVehicleLocations(validLocations);
        if (!isBackground && window.innerWidth < 768) setIsSidebarOpen(false);
    } catch (err: any) {
        if (!isBackground) setAllVehiclesError(err.message || "Failed to fetch vehicle list.");
    } finally {
        if (!isBackground) setIsFetchingAllVehicles(false);
    }
  };

  const handleFindClosestVehicles = async (targetFleet: string) => {
    let vehiclesToProcess = allVehicleLocations;
    let targetVehicle = vehiclesToProcess.find(v => v.fleet === targetFleet);
    if (!targetVehicle && currentLocation && currentLocation.fleet === targetFleet) targetVehicle = currentLocation;
    if (!targetVehicle) return;

    if (vehiclesToProcess.length === 0) {
        setIsFetchingAllVehicles(true);
        try { vehiclesToProcess = await fetchAllVehiclesList(); } catch (err) {
            setAllVehiclesError("Failed to fetch vehicle list for comparison.");
            setIsFetchingAllVehicles(false); return;
        } finally { setIsFetchingAllVehicles(false); }
    }
    
    const targetInList = vehiclesToProcess.find(v => v.fleet === targetFleet);
    if (targetInList) targetVehicle = targetInList;
    else vehiclesToProcess = [...vehiclesToProcess, targetVehicle];

    const toRad = (x: number) => (x * Math.PI) / 180;
    const R = 6371;
    const distances = vehiclesToProcess.filter(v => v.fleet !== targetFleet).map(v => {
        const dLat = toRad(v.lat - targetVehicle!.lat);
        const dLon = toRad(v.lng - targetVehicle!.lng);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(targetVehicle!.lat)) * Math.cos(toRad(v.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return { ...v, distance: R * c };
      });
    
    distances.sort((a, b) => a.distance - b.distance);
    const closest = distances.slice(0, 5);
    setAllVehicleLocations([targetVehicle, ...closest.map(c => { const { distance, ...rest } = c; return rest as CurrentLocationData; })]);
    setCurrentLocation(null);
    setIsViewAllMode(true);
    setIsLiveTracking(false); 
  };

  useEffect(() => {
    let intervalId: number | undefined;
    if (isLiveTracking) {
        intervalId = window.setInterval(() => {
            if (isViewAllMode) handleFetchAllVehicles(true);
            else if (trackedVehicleIds.some(v => v.trim() !== '')) handleFetchCurrentLocation();
        }, 30000);
    }
    return () => { if (intervalId !== undefined) clearInterval(intervalId); };
  }, [isLiveTracking, trackedVehicleIds, isViewAllMode]);


  // UPDATED: Using Google Geocoder for the main search button action (Enter/Click)
  const handleAddressSearch = async () => {
    if (!addressQuery.trim()) { setSearchError("Please enter an address."); return; }
    if (typeof google === 'undefined') { setSearchError("Google Services not initialized."); return; }
    
    setIsSearching(true); setSearchError(null); setSearchedLocation(null);
    
    const geocoder = new google.maps.Geocoder();
    const request = {
        address: addressQuery,
        componentRestrictions: { country: 'us' },
        bounds: { north: 39.5, south: 39.0, east: -76.5, west: -77.2 } // Biased to MD/Howard County
    };

    geocoder.geocode(request, (results: any, status: any) => {
        setIsSearching(false);
        if (status === 'OK' && results[0]) {
            const result = results[0];
            setSearchedLocation({ 
                lat: result.geometry.location.lat(), 
                lng: result.geometry.location.lng(), 
                displayName: result.formatted_address 
            });
            setAddressQuery(result.formatted_address);
            if (window.innerWidth < 768) setIsSidebarOpen(false);
        } else {
            setSearchError("Location not found. Please try adding a city or zip code.");
        }
    });
  };

  const handleLocationSelect = (location: SearchedLocation) => {
    setSearchedLocation(location);
    setAddressQuery(location.displayName);
    setSearchError(null);
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };
  
  const handleClearSearch = () => { setAddressQuery(''); setSearchedLocation(null); setSearchError(null); };

  const handleClearAllMapData = () => {
    setTripData(null);
    setSearchedLocation(null);
    setAddressQuery('');
    setCurrentLocation(null);
    setTrackedCurrentLocations([]);
    setAllVehicleLocations([]);
    setSelectedRouteStops(null);
    setNavigationData(null);
    setIsLiveTracking(false);
    setIsViewAllMode(false);
    setSelectedRoute(null);
    setRouteDetailsError(null);
    setSearchError(null);
    setError(null);
    setCurrentLocationError(null);
    setAllVehiclesError(null);
  };

  useEffect(() => {
    const fetchNavigationRoute = async () => {
        if (!currentLocation || !searchedLocation) return;
        setIsFetchingNavigation(true); setNavigationError(null); setNavigationData(null);
        
        const body = JSON.stringify({
            origin: { location: { latLng: { latitude: currentLocation.lat, longitude: currentLocation.lng } } },
            destination: { location: { latLng: { latitude: searchedLocation.lat, longitude: searchedLocation.lng } } },
            travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE',
        });

        try {
            const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_API_KEY, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline' },
                body: body,
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data?.error?.message || `API error: ${response.status}`);
            if (!data.routes || data.routes.length === 0) throw new Error("No route found.");
            const route = data.routes[0];
            const path = decodePolyline(route.polyline.encodedPolyline);
            const durationInSeconds = route.duration ? parseInt(route.duration.slice(0, -1), 10) : 0;
            const distanceString = route.distanceMeters ? `${(route.distanceMeters * 0.000621371).toFixed(1)} mi` : 'N/A';
            setNavigationData({ path, duration: durationInSeconds, distance: distanceString });
        } catch (err: any) {
             setNavigationError(`Route Fetch Failed: ${err.message}`);
             setNavigationData(null);
        } finally { setIsFetchingNavigation(false); }
    };
    fetchNavigationRoute();
  }, [currentLocation, searchedLocation]);


  const handleFetchRoutes = async () => {
    setIsFetchingRoutes(true); setRoutesError(null); clearRouteData();
    const paddedFleet = fleet.length === 2 && /^\d+$/.test(fleet) ? `0${fleet}` : fleet;
    try {
        const findFolderId = async (name: string, parentId: string) => {
            const res = await gapi.client.drive.files.list({ q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`, fields: 'files(id, name)' });
            return res.result.files?.[0]?.id || null;
        };
        const busStopsFolderId = await findFolderId('Bus Stops', ROUTES_FOLDER_ID);
        if (!busStopsFolderId) throw new Error("Could not find 'Bus Stops' folder.");
        const vehicleFolderId = await findFolderId(paddedFleet, busStopsFolderId);
        if (!vehicleFolderId) throw new Error(`No route folder for ${paddedFleet}.`);
        const filesResponse = await gapi.client.drive.files.list({ q: `'${vehicleFolderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`, fields: 'files(id, name)', orderBy: 'name' });
        setRoutes(filesResponse.result.files?.map(f => ({ id: f.id, name: f.name })) || []);
        setSidebarView('routes');
    } catch (err: any) {
        setRoutesError(err.message);
    } finally { setIsFetchingRoutes(false); }
  };

  const handleSelectRoute = async (routeFile: DriveFile) => {
    setIsFetchingRouteDetails(true); setSelectedRoute(routeFile); setRouteDetailsError(null); setSelectedRouteStops(null);
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: routeFile.id, range: 'A2:I' });
        const values = response.result.values;
        if (!values || values.length === 0) throw new Error("Sheet is empty.");
        const stops: RouteStop[] = values.map((row: any[], index: number) => ({
            id: index, stopNumber: row[0] || '', time: row[1] || '', stopLocation: row[2] || '', studentName: row[3] || '', contactName: row[4] || '', phoneNumber: row[5] || '', otherEquipment: row[6] || '', latitude: parseFloat(row[7]), longitude: parseFloat(row[8]),
        })).filter(stop => !isNaN(stop.latitude) && !isNaN(stop.longitude) && stop.latitude !== 0);
        setSelectedRouteStops(stops);
        if (window.innerWidth < 768) setIsSidebarOpen(false);
    } catch (err: any) {
        setRouteDetailsError(err.message);
    } finally { setIsFetchingRouteDetails(false); }
  }

  return (
    <div className="flex h-screen w-screen bg-gray-900 text-gray-100 font-sans overflow-hidden">
      <Sidebar
        isSidebarOpen={isSidebarOpen} setIsSidebarOpen={setIsSidebarOpen} tripData={tripData} fleet={fleet} setFleet={setFleet} vehicleIds={trackedVehicleIds} vehicleMarkerColors={VEHICLE_MARKER_COLORS} vehicleOptions={cachedVehicleNumbers || []} onVehicleIdChange={handleUpdateTrackedVehicleId} onVehicleSelectAndLocate={handleSelectVehicleAndLocate} onAddVehicleId={handleAddTrackedVehicleId} onRemoveVehicleId={handleRemoveTrackedVehicleId} startDate={startDate} setStartDate={setStartDate} startTime={startTime} setStartTime={setStartTime} endDate={endDate} setEndDate={setEndDate} endTime={endTime} setEndTime={setEndTime} handleFetch={handleFetchData} isLoading={isLoading} error={error} handleClearTripData={handleClearTripData} addressQuery={addressQuery} setAddressQuery={setAddressQuery} searchedLocation={searchedLocation} handleAddressSearch={handleAddressSearch} handleClearSearch={handleClearSearch} isSearching={isSearching} searchError={searchError} setHoveredEventTimestamp={setHoveredEventTimestamp} setSelectedEventTimestamp={setSelectedEventTimestamp} currentLocation={currentLocation} handleFetchCurrentLocation={() => handleFetchCurrentLocation()} handleClearCurrentLocation={handleClearCurrentLocation} isFetchingCurrentLocation={isFetchingCurrentLocation} currentLocationError={currentLocationError} isLiveTracking={isLiveTracking} setIsLiveTracking={setIsLiveTracking} handleFetchAllVehicles={() => handleFetchAllVehicles(false)} isFetchingAllVehicles={isFetchingAllVehicles} allVehicleLocations={allVehicleLocations} allVehiclesError={allVehiclesError} sidebarView={sidebarView} handleFetchRoutes={handleFetchRoutes} isFetchingRoutes={isFetchingRoutes} routes={routes} routesError={routesError} handleBackToMainView={() => setSidebarView('main')} handleSelectRoute={handleSelectRoute} selectedRoute={selectedRoute} selectedRouteStops={selectedRouteStops} isFetchingRouteDetails={isFetchingRouteDetails} routeDetailsError={routeDetailsError} hoveredRouteStopId={hoveredRouteStopId} setHoveredRouteStopId={setHoveredRouteStopId} isGapiReady={isGapiReady} navigationData={navigationData} isFetchingNavigation={isFetchingNavigation} navigationError={navigationError} onLocationSelect={handleLocationSelect}
      />
      <div className="relative flex-1 h-full">
         <button onClick={() => setIsSidebarOpen(true)} className="md:hidden absolute top-4 left-4 z-[4010] flex items-center p-2 bg-gray-800/70 backdrop-blur-sm border border-gray-600 rounded-md shadow-lg text-white hover:bg-gray-700 transition-colors">
            <MenuIcon className="w-6 h-6" /> <span className="ml-2 font-semibold text-sm">Trip Details</span>
        </button>
        <main className="flex-1 h-full">
            <MapWrapper tripData={tripData} searchedLocation={searchedLocation} hoveredEventTimestamp={hoveredEventTimestamp} selectedEventTimestamp={selectedEventTimestamp} currentLocation={currentLocation} trackedLocations={trackedCurrentLocations} allVehicleLocations={allVehicleLocations} routeStops={selectedRouteStops} hoveredRouteStopId={hoveredRouteStopId} navigationData={navigationData} isTracking={isLiveTracking} onToggleTracking={() => setIsLiveTracking(prev => !prev)} onFindClosestVehicles={handleFindClosestVehicles} onClearMap={handleClearAllMapData} onClearCurrentLocation={handleClearCurrentLocation} onClearPath={handleClearTripData} onClearAddressPath={handleClearAddressPath} />
        </main>
      </div>
    </div>
  );
};

export default App;
