
import React, { useEffect, useRef } from 'react';
import { TripData, EventType, PathPoint, SearchedLocation, CurrentLocationData, RouteStop, NavigationData } from '../types';

declare const L: any; // Using Leaflet from CDN

interface MapWrapperProps {
  tripData: TripData | null;
  searchedLocation: SearchedLocation | null;
  hoveredEventTimestamp: number | null;
  selectedEventTimestamp: number | null;
  currentLocation: CurrentLocationData | null;
  trackedLocations?: Array<CurrentLocationData & { markerColor: string }>;
  allVehicleLocations?: CurrentLocationData[]; // Optional array for multi-view
  routeStops: RouteStop[] | null;
  hoveredRouteStopId: number | null;
  navigationData: NavigationData | null;
  isTracking: boolean;
  onToggleTracking?: () => void;
  onFindClosestVehicles?: (vehicleId: string) => void;
  onClearMap?: () => void;
  onClearCurrentLocation?: () => void;
  onClearPath?: () => void;
  onClearAddressPath?: () => void;
}

const createIcon = (svg: string, size: [number, number]) => {
  return L.divIcon({
    html: svg,
    className: 'bg-transparent border-none',
    iconSize: size,
    iconAnchor: [size[0] / 2, size[1]],
  });
};

const formatTooltipContent = (point: PathPoint): string => {
  return `
    <div class="text-xs">
      <div><strong>Time:</strong> ${new Date(point.timestamp).toLocaleTimeString()}</div>
      <div><strong>Speed:</strong> ${point.speed.toFixed(1)} mph</div>
      <div><strong>Heading:</strong> ${point.heading}</div>
    </div>
  `;
};

const cardinalToDegrees = (heading: string): number => {
  const map: Record<string, number> = {
    N: 0,
    NNE: 22.5,
    NE: 45,
    ENE: 67.5,
    E: 90,
    ESE: 112.5,
    SE: 135,
    SSE: 157.5,
    S: 180,
    SSW: 202.5,
    SW: 225,
    WSW: 247.5,
    W: 270,
    WNW: 292.5,
    NW: 315,
    NNW: 337.5,
  };
  return map[heading] ?? 0;
};

const formatFleetMarkerLabel = (fleet: string): string => {
  const trimmed = (fleet || '').trim().toUpperCase();
  const vanMatch = trimmed.match(/^V-(\d{1,2})$/);
  if (vanMatch) return `V${parseInt(vanMatch[1], 10)}`;
  return trimmed;
};

const MapWrapper: React.FC<MapWrapperProps> = ({ tripData, searchedLocation, hoveredEventTimestamp, selectedEventTimestamp, currentLocation, trackedLocations = [], allVehicleLocations = [], routeStops, hoveredRouteStopId, navigationData, isTracking, onToggleTracking, onFindClosestVehicles, onClearMap, onClearCurrentLocation, onClearPath, onClearAddressPath }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const tripLayersRef = useRef<any[]>([]);
  const searchMarkerRef = useRef<any>(null);
  const currentLocationMarkerRef = useRef<any>(null);
  const allVehiclesLayerRef = useRef<any>(null);
  const trackedVehiclesLayerRef = useRef<any>(null);
  const waypointMarkersRef = useRef<Map<number, any>>(new Map());
  const highlightedMarkerRef = useRef<any>(null);
  const routeStopsLayerRef = useRef<any>(null);
  const routeStopMarkersRef = useRef<Map<number, any>>(new Map());
  const highlightedStopMarkerRef = useRef<any>(null);
  const navigationLayerRef = useRef<any>(null);

  useEffect(() => {
    if (mapRef.current && !mapInstance.current) {
      // Define Base Layers
      const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        className: 'dark-mode-tiles', // Only apply dark mode filter to this layer
        maxNativeZoom: 19,
        maxZoom: 22,
      });

      const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxNativeZoom: 19,
        maxZoom: 22,
      });

      mapInstance.current = L.map(mapRef.current, {
        center: [39.2396, -76.8403], // Default center: Howard County, MD
        zoom: 10,
        maxZoom: 22,
        zoomControl: false, 
        layers: [streetLayer] // Default layer
      });

      // Add Layer Control
      const baseMaps = {
        "Street Map": streetLayer,
        "Satellite": satelliteLayer
      };
      L.control.layers(baseMaps, null, { position: 'topright' }).addTo(mapInstance.current);

      L.control.zoom({ position: 'bottomright' }).addTo(mapInstance.current);
    }

    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapInstance.current) return;

    // Clear previous trip layers
    tripLayersRef.current.forEach(layer => mapInstance.current.removeLayer(layer));
    tripLayersRef.current = [];
    waypointMarkersRef.current.clear();
    
    if (!tripData || !tripData.path || tripData.path.length === 0) return;

    const { path, events } = tripData;
    const latLngs = path.map(p => [p.lat, p.lng]);

    // Draw path
    const polyline = L.polyline(latLngs, { color: '#06b6d4', weight: 4, opacity: 0.8 });
    polyline.addTo(mapInstance.current);
    tripLayersRef.current.push(polyline);
    
    // Add directional arrows
    const arrowDecorator = L.polylineDecorator(polyline, {
      patterns: [
        {
          offset: '10%',
          repeat: '100px',
          symbol: L.Symbol.arrowHead({
            pixelSize: 12,
            polygon: false,
            pathOptions: {
              stroke: true,
              weight: 2,
              color: '#0891b2' // slightly darker cyan
            }
          })
        }
      ]
    });
    arrowDecorator.addTo(mapInstance.current);
    tripLayersRef.current.push(arrowDecorator);

    // --- RENDER WAYPOINT MARKERS ---
    const waypointIcon = L.divIcon({
        html: '<div class="waypoint-inner"></div>', // Inner div for styling
        className: 'waypoint-marker', // Container for positioning
        iconSize: [12, 12],
        iconAnchor: [6, 6] // Center of the circle
    });

    path.forEach(point => {
        const waypointMarker = L.marker([point.lat, point.lng], {
            icon: waypointIcon,
            riseOnHover: true, // Bring marker to front on hover
        });

        waypointMarker.bindTooltip(formatTooltipContent(point), {
            permanent: false,
            direction: 'top',
            offset: L.point(0, -8), // Adjust to appear just above the marker
            className: 'waypoint-tooltip'
        });

        waypointMarker.addTo(mapInstance.current);
        tripLayersRef.current.push(waypointMarker);
        waypointMarkersRef.current.set(point.timestamp, waypointMarker);
    });

    // Fit map to path bounds
    mapInstance.current.fitBounds(polyline.getBounds(), { padding: [50, 50] });

    // --- RENDER START/END MARKERS (on top of waypoints) ---
    const startEvent = events.find(e => e.type === EventType.START);
    if (startEvent) {
        const startIcon = createIcon(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="text-green-400 w-8 h-8 drop-shadow-lg">
            <path fill-rule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.976 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.274 1.765 11.842 11.842 0 00.757.433.57.57 0 00.281.14l.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clip-rule="evenodd" />
          </svg>`,
          [32, 32]
        );
        const startMarker = L.marker(startEvent.location, { icon: startIcon, zIndexOffset: 1000 }).bindPopup(`<b>Trip Start</b>`);
        startMarker.addTo(mapInstance.current);
        tripLayersRef.current.push(startMarker);
    }
    
    const endEvent = events.find(e => e.type === EventType.END);
     if (endEvent) {
        const endIcon = createIcon(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="text-red-500 w-8 h-8 drop-shadow-lg">
              <path fill-rule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.976 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.274 1.765 11.842 11.842 0 00.757.433.57.57 0 00.281.14l.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clip-rule="evenodd" />
            </svg>`,
            [32, 32]
        );
        const endMarker = L.marker(endEvent.location, { icon: endIcon, zIndexOffset: 1000 }).bindPopup("<b>Trip End</b>");
        endMarker.addTo(mapInstance.current);
        tripLayersRef.current.push(endMarker);
    }

  }, [tripData]);

    useEffect(() => {
        if (!mapInstance.current) return;
        if (routeStopsLayerRef.current) {
            mapInstance.current.removeLayer(routeStopsLayerRef.current);
            routeStopsLayerRef.current = null;
        }
        routeStopMarkersRef.current.clear();

        if (routeStops && routeStops.length > 0) {
            const markers = routeStops.map(stop => {
                const icon = L.divIcon({
                    html: `<div class="route-stop-inner"><span class="route-stop-number">${stop.stopNumber}</span></div>`,
                    className: 'route-stop-marker-container',
                    iconSize: [28, 28],
                    iconAnchor: [14, 14]
                });
                const tooltipContent = `
                  <div class="font-sans text-sm">
                    ${stop.stopLocation ? `<div class="font-bold text-base mb-1">${stop.stopLocation}</div>` : ''}
                    ${stop.time ? `<div><strong>Time:</strong> ${stop.time}</div>` : ''}
                    ${stop.studentName ? `<div><strong>Student:</strong> ${stop.studentName}</div>` : ''}
                    ${stop.otherEquipment ? `<div><strong>Equipment:</strong> ${stop.otherEquipment}</div>` : ''}
                    ${stop.phoneNumber ? `<div><strong>Phone:</strong> ${stop.phoneNumber}</div>` : ''}
                    ${stop.contactName ? `<div><strong>Contact:</strong> ${stop.contactName}</div>` : ''}
                  </div>`.replace(/\s\s+/g, ' ').trim();

                const marker = L.marker([stop.latitude, stop.longitude], { 
                    icon,
                    riseOnHover: true 
                });
                marker.bindTooltip(tooltipContent, {
                    direction: 'top',
                    offset: L.point(0, -14),
                    className: 'waypoint-tooltip'
                });
                routeStopMarkersRef.current.set(stop.id, marker);
                return marker;
            });
            const featureGroup = L.featureGroup(markers);
            featureGroup.addTo(mapInstance.current);
            routeStopsLayerRef.current = featureGroup;
            mapInstance.current.fitBounds(featureGroup.getBounds(), { padding: [50, 50], maxZoom: 16 });
        }
    }, [routeStops]);

  useEffect(() => {
    if (!mapInstance.current) return;
    if (highlightedMarkerRef.current) {
        const prevMarker = highlightedMarkerRef.current;
        const element = prevMarker.getElement();
        if (element) {
            element.classList.remove('waypoint-marker-highlighted');
        }
        prevMarker.setZIndexOffset(0);
        highlightedMarkerRef.current = null;
    }
    if (hoveredEventTimestamp) {
        const markerToHighlight = waypointMarkersRef.current.get(hoveredEventTimestamp);
        if (markerToHighlight) {
            const element = markerToHighlight.getElement();
            if (element) {
                element.classList.add('waypoint-marker-highlighted');
            }
            markerToHighlight.setZIndexOffset(2000);
            highlightedMarkerRef.current = markerToHighlight;
        }
    }
  }, [hoveredEventTimestamp]);

  useEffect(() => {
    if (!mapInstance.current) return;
    // Clear previous highlight
    if (highlightedStopMarkerRef.current) {
        const prevMarker = highlightedStopMarkerRef.current;
        const element = prevMarker.getElement();
        if (element) {
            element.classList.remove('route-stop-marker-highlighted');
        }
        prevMarker.setZIndexOffset(0); // Restore default z-index
        highlightedStopMarkerRef.current = null;
    }

    // Apply new highlight
    if (hoveredRouteStopId !== null) {
        const markerToHighlight = routeStopMarkersRef.current.get(hoveredRouteStopId);
        if (markerToHighlight) {
            const element = markerToHighlight.getElement();
            if (element) {
                element.classList.add('route-stop-marker-highlighted');
            }
            markerToHighlight.setZIndexOffset(2000); // Programmatically bring to front
            highlightedStopMarkerRef.current = markerToHighlight;
        }
    }
  }, [hoveredRouteStopId]);

  useEffect(() => {
    if (!mapInstance.current || !selectedEventTimestamp) return;

    const markerToSelect = waypointMarkersRef.current.get(selectedEventTimestamp);
    if (markerToSelect) {
        const latLng = markerToSelect.getLatLng();
        mapInstance.current.flyTo(latLng, 17, {
            animate: true,
            duration: 1.5
        });
    }
  }, [selectedEventTimestamp]);

  useEffect(() => {
    if (!mapInstance.current) return;
    if (searchMarkerRef.current) {
        mapInstance.current.removeLayer(searchMarkerRef.current);
        searchMarkerRef.current = null;
    }
    if (searchedLocation) {
        const searchIcon = createIcon(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="text-purple-500 w-8 h-8 drop-shadow-lg">
              <path fill-rule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.976 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.274 1.765 11.842 11.842 0 00.757.433.57.57 0 00.281.14l.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clip-rule="evenodd" />
            </svg>`,
            [32, 32]
        );
        
        const marker = L.marker([searchedLocation.lat, searchedLocation.lng], {
            icon: searchIcon,
            zIndexOffset: 900
        }).bindPopup(`<b>Searched Location:</b><br>${searchedLocation.displayName}`);
        marker.addTo(mapInstance.current);
        searchMarkerRef.current = marker;
        mapInstance.current.flyTo([searchedLocation.lat, searchedLocation.lng], 15);
    }
  }, [searchedLocation]);

  // Handle Single Current Location
  useEffect(() => {
    if (!mapInstance.current) return;
    if (trackedVehiclesLayerRef.current) {
        mapInstance.current.removeLayer(trackedVehiclesLayerRef.current);
        trackedVehiclesLayerRef.current = null;
    }
    if (trackedLocations.length > 0) {
        const markers = trackedLocations.map(veh => {
            const headingDegrees = cardinalToDegrees(veh.heading);
            const isPoweredOn = veh.power?.toLowerCase() === 'on';
            const markerColor = veh.markerColor || '#facc15';
            const icon = createIcon(
                `<div style="transform: rotate(${headingDegrees}deg); transform-origin: center center;">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="34" height="34" aria-label="Vehicle heading marker">
                    <g filter="drop-shadow(0 2px 4px rgba(0,0,0,0.55))">
                      <path d="M20 4 L31 30 L20 24 L9 30 Z"
                        fill="${isPoweredOn ? markerColor : 'transparent'}"
                        stroke="${markerColor}"
                        stroke-width="2.5"
                        stroke-linejoin="round" />
                    </g>
                  </svg>
                </div>`,
                [34, 34]
            );

            const marker = L.marker([veh.lat, veh.lng], {
                icon,
                zIndexOffset: 1500,
            });
            const popupContent = `
                <div class="font-sans min-w-[150px]">
                  <div class="font-bold text-base mb-1">Vehicle: ${veh.fleet}</div>
                  <div><b>Time:</b> ${new Date(veh.timestamp).toLocaleString()}</div>
                  <div><b>Speed:</b> ${veh.speed}</div>
                  <div><b>Power:</b> <span class="capitalize">${veh.power}</span></div>
                  <button id="track-btn-single-${veh.fleet}" class="mt-3 w-full ${isTracking ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700 hover:bg-gray-600'} text-white text-xs font-bold py-1.5 px-2 rounded transition-colors shadow-sm flex items-center justify-center">
                    TRACK: ${isTracking ? 'ON' : 'OFF'}
                  </button>
                  <button id="closest-btn-single-${veh.fleet}" class="mt-3 w-full bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-bold py-1.5 px-2 rounded transition-colors shadow-sm flex items-center justify-center">
                    View Closest 5 Vehicles
                  </button>
                </div>
            `;
            marker.bindPopup(popupContent);

            marker.on('popupopen', () => {
                 const btn = document.getElementById(`closest-btn-single-${veh.fleet}`);
                 if (btn) {
                     btn.onclick = (e) => {
                         e.preventDefault();
                         e.stopPropagation();
                         if (onFindClosestVehicles) {
                            onFindClosestVehicles(veh.fleet);
                            marker.closePopup();
                         }
                     };
                 }
                 const trackBtn = document.getElementById(`track-btn-single-${veh.fleet}`);
                 if (trackBtn) {
                     trackBtn.onclick = (e) => {
                         e.preventDefault();
                         e.stopPropagation();
                         if (onToggleTracking) {
                             onToggleTracking();
                             marker.closePopup();
                         }
                     };
                 }
             });
            return marker;
        });

        const featureGroup = L.featureGroup(markers);
        featureGroup.addTo(mapInstance.current);
        trackedVehiclesLayerRef.current = featureGroup;
        mapInstance.current.fitBounds(featureGroup.getBounds(), { padding: [50, 50], maxZoom: 16 });
    }
  }, [trackedLocations, isTracking, onFindClosestVehicles, onToggleTracking]);

  // Handle All Vehicles Locations
  useEffect(() => {
    if (!mapInstance.current) return;

    // Clear existing all-vehicles layer
    if (allVehiclesLayerRef.current) {
        mapInstance.current.removeLayer(allVehiclesLayerRef.current);
        allVehiclesLayerRef.current = null;
    }

    if (allVehicleLocations && allVehicleLocations.length > 0) {
        const markers = allVehicleLocations.map(veh => {
             const markerLabel = formatFleetMarkerLabel(veh.fleet);
             const isPoweredOn = veh.power?.toLowerCase() === 'on';
             const icon = L.divIcon({
                html: `<div style="background-color: ${isPoweredOn ? '#eab308' : 'transparent'}; color: ${isPoweredOn ? '#000' : '#facc15'}; border: 2px solid #facc15; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${markerLabel}</div>`,
                className: 'custom-vehicle-marker',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });

             const marker = L.marker([veh.lat, veh.lng], { icon, riseOnHover: true });
             
             const popupContent = `
                <div class="font-sans min-w-[150px]">
                  <div class="font-bold text-base mb-2 text-center border-b border-gray-300 pb-1">Bus ${veh.fleet}</div>
                  <div class="space-y-1 text-sm">
                      <div><b>Speed:</b> ${veh.speed}</div>
                      <div><b>Heading:</b> ${veh.heading}</div>
                      <div><b>Last Seen:</b> ${new Date(veh.timestamp).toLocaleTimeString()}</div>
                  </div>
                  <button id="track-btn-${veh.fleet}" class="mt-3 w-full ${isTracking ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700 hover:bg-gray-600'} text-white text-xs font-bold py-1.5 px-2 rounded transition-colors shadow-sm flex items-center justify-center">
                    TRACK: ${isTracking ? 'ON' : 'OFF'}
                  </button>
                  <button id="closest-btn-${veh.fleet}" class="mt-3 w-full bg-cyan-600 hover:bg-cyan-700 text-white text-xs font-bold py-1.5 px-2 rounded transition-colors shadow-sm flex items-center justify-center">
                    View Closest 5 Vehicles
                  </button>
                </div>
             `;
             
             marker.bindPopup(popupContent);
             
             // Attach event listener when popup opens because the button DOM element doesn't exist until then
             marker.on('popupopen', () => {
                 const btn = document.getElementById(`closest-btn-${veh.fleet}`);
                 if (btn) {
                     btn.onclick = (e) => {
                         e.preventDefault();
                         e.stopPropagation();
                         if (onFindClosestVehicles) {
                            onFindClosestVehicles(veh.fleet);
                            marker.closePopup();
                         }
                     };
                 }
                 const trackBtn = document.getElementById(`track-btn-${veh.fleet}`);
                 if (trackBtn) {
                     trackBtn.onclick = (e) => {
                         e.preventDefault();
                         e.stopPropagation();
                         if (onToggleTracking) {
                            onToggleTracking();
                            marker.closePopup();
                         }
                     };
                 }
             });

             return marker;
        });

        const featureGroup = L.featureGroup(markers);
        featureGroup.addTo(mapInstance.current);
        allVehiclesLayerRef.current = featureGroup;

        // Fit bounds to show all vehicles
        mapInstance.current.fitBounds(featureGroup.getBounds(), { padding: [50, 50], maxZoom: 14 });
    }

  }, [allVehicleLocations, isTracking, onFindClosestVehicles, onToggleTracking]);

  useEffect(() => {
    if (!mapInstance.current) return;

    // Clear previous navigation layer
    if (navigationLayerRef.current) {
        mapInstance.current.removeLayer(navigationLayerRef.current);
        navigationLayerRef.current = null;
    }

    if (navigationData && navigationData.path.length > 0) {
        const navPolyline = L.polyline(navigationData.path, {
            color: '#22c55e', // a vibrant green (tailwind green-500)
            weight: 6,
            opacity: 0.75,
        });
        navPolyline.addTo(mapInstance.current);
        navigationLayerRef.current = navPolyline;
    }
  }, [navigationData]);


  return (
    <div className="relative w-full h-full">
        <div ref={mapRef} className="w-full h-full" />

        <div className="absolute top-20 right-[10px] z-[1000] flex flex-col gap-2 items-end">
            {(trackedLocations.length > 0 || allVehicleLocations.length > 0) && (
                <button
                    onClick={() => onClearCurrentLocation?.()}
                    className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-md shadow-md text-gray-200 hover:text-red-300 hover:bg-gray-700 transition-colors text-xs font-semibold uppercase tracking-wide"
                    title="Clear current vehicle location markers"
                >
                    Clear Current Location
                </button>
            )}

            {tripData && (
                <button
                    onClick={() => onClearPath?.()}
                    className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-md shadow-md text-gray-200 hover:text-red-300 hover:bg-gray-700 transition-colors text-xs font-semibold uppercase tracking-wide"
                    title="Clear vehicle path from map"
                >
                    Clear Path
                </button>
            )}

            {navigationData && (
                <button
                    onClick={() => onClearAddressPath?.()}
                    className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-md shadow-md text-gray-200 hover:text-red-300 hover:bg-gray-700 transition-colors text-xs font-semibold uppercase tracking-wide"
                    title="Clear navigation route and searched address"
                >
                    Clear Address Path
                </button>
            )}

            <button
                onClick={() => onClearMap?.()}
                className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-md shadow-md text-red-300 hover:text-red-200 hover:bg-gray-700 transition-colors text-xs font-semibold uppercase tracking-wide"
                title="Clear all path data, markers, and searches from map"
            >
                Clear Map
            </button>
        </div>

        {currentLocation && (
            <a
                href={`https://www.google.com/maps?q=${currentLocation.lat},${currentLocation.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute bottom-[23px] right-14 z-[1000] flex items-center px-3 py-2 bg-gray-800/80 backdrop-blur-sm border border-gray-600 rounded-md shadow-lg text-white hover:bg-gray-700/90 transition-colors"
                aria-label="Open current location in Google Maps"
                title="Open in Google Maps"
            >
                <span className="text-sm font-medium whitespace-nowrap">Open in Google Maps</span>
            </a>
        )}
    </div>
  );
};

export default MapWrapper;
