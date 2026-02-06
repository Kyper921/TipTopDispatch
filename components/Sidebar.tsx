
import React, { useState, useEffect, useRef } from 'react';
import { TripData, VehicleEvent, EventType, SearchedLocation, CurrentLocationData, DriveFile, NavigationData, RouteStop } from '../types';
import { MapPinIcon, StartFlagIcon, EndFlagIcon, SpinnerIcon, SearchIcon, CloseIcon, LocateIcon, ArrowLeftIcon, RouteIcon } from './icons/Icons';
import TimePicker from './TimePicker';

declare const google: any;

interface SidebarProps {
  tripData: TripData | null;
  fleet: string;
  setFleet: (value: string) => void;
  vehicleIds: string[];
  vehicleMarkerColors: string[];
  vehicleOptions: string[];
  onVehicleIdChange: (index: number, value: string) => void;
  onVehicleSelectAndLocate: (index: number, value: string) => void;
  onAddVehicleId: () => void;
  onRemoveVehicleId: (index: number) => void;
  startDate: string;
  setStartDate: (value: string) => void;
  startTime: string;
  setStartTime: (value: string) => void;
  endDate: string;
  setEndDate: (value: string) => void;
  endTime: string;
  setEndTime: (value: string) => void;
  handleFetch: () => void;
  isLoading: boolean;
  error: string | null;
  handleClearTripData: () => void;
  addressQuery: string;
  setAddressQuery: (value: string) => void;
  searchedLocation: SearchedLocation | null;
  handleAddressSearch: () => void;
  handleClearSearch: () => void;
  isSearching: boolean;
  searchError: string | null;
  setHoveredEventTimestamp: (timestamp: number | null) => void;
  setSelectedEventTimestamp: (timestamp: number | null) => void;
  isSidebarOpen: boolean;
  setIsSidebarOpen: (isOpen: boolean) => void;
  currentLocation: CurrentLocationData | null;
  handleFetchCurrentLocation: () => void;
  handleClearCurrentLocation: () => void;
  isFetchingCurrentLocation: boolean;
  currentLocationError: string | null;
  isLiveTracking: boolean;
  setIsLiveTracking: (enabled: boolean) => void;
  handleFetchAllVehicles: () => void;
  isFetchingAllVehicles: boolean;
  allVehicleLocations: CurrentLocationData[];
  allVehiclesError: string | null;
  sidebarView: 'main' | 'routes';
  handleFetchRoutes: () => void;
  isFetchingRoutes: boolean;
  routes: DriveFile[] | null;
  routesError: string | null;
  handleBackToMainView: () => void;
  handleSelectRoute: (routeFile: DriveFile) => void;
  selectedRoute: DriveFile | null;
  selectedRouteStops: RouteStop[] | null;
  isFetchingRouteDetails: boolean;
  routeDetailsError: string | null;
  hoveredRouteStopId: number | null;
  setHoveredRouteStopId: (id: number | null) => void;
  isGapiReady: boolean;
  navigationData: NavigationData | null;
  isFetchingNavigation: boolean;
  navigationError: string | null;
  onLocationSelect: (location: SearchedLocation) => void;
}

const getEventIcon = (type: EventType) => {
    switch (type) {
        case EventType.START: return <StartFlagIcon className="w-5 h-5 text-green-400" />;
        case EventType.END: return <EndFlagIcon className="w-5 h-5 text-red-400" />;
        case EventType.STOP: return <MapPinIcon className="w-5 h-5 text-yellow-400" />;
        default: return <MapPinIcon className="w-5 h-5 text-gray-400" />;
    }
};

const AccordionSection: React.FC<{ title: string; children: React.ReactNode; isOpen?: boolean }> = ({ title, children, isOpen: defaultOpen = false }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="border-b border-gray-700 last:border-0">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex justify-between items-center p-4 bg-gray-800/40 hover:bg-gray-800/80 transition-colors text-left"
            >
                <span className="font-semibold text-gray-200">{title}</span>
                <span className={`transform transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-gray-400">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </span>
            </button>
            <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isOpen ? 'max-h-[1200px] opacity-100' : 'max-h-0 opacity-0'}`}>
               {children}
            </div>
        </div>
    );
};


const Sidebar: React.FC<SidebarProps> = ({
    tripData, fleet, setFleet, vehicleIds, vehicleMarkerColors, vehicleOptions, onVehicleIdChange, onVehicleSelectAndLocate, onAddVehicleId, onRemoveVehicleId, startDate, setStartDate, startTime, setStartTime, endDate, setEndDate, endTime, setEndTime, handleFetch, isLoading, error, handleClearTripData, addressQuery, setAddressQuery, searchedLocation, handleAddressSearch, handleClearSearch, isSearching, searchError, setHoveredEventTimestamp, setSelectedEventTimestamp, isSidebarOpen, setIsSidebarOpen, currentLocation, handleFetchCurrentLocation, handleClearCurrentLocation, isFetchingCurrentLocation, currentLocationError, isLiveTracking, setIsLiveTracking, sidebarView, handleFetchRoutes, isFetchingRoutes, routes, routesError, handleBackToMainView, handleSelectRoute, selectedRoute, selectedRouteStops, isFetchingRouteDetails, routeDetailsError, hoveredRouteStopId, setHoveredRouteStopId, isGapiReady, navigationData, isFetchingNavigation, navigationError, onLocationSelect, handleFetchAllVehicles, isFetchingAllVehicles, allVehicleLocations, allVehiclesError
}) => {
  const startTimeStamp = tripData?.events.find(e => e.type === EventType.START)?.timestamp;
  const endTimeStamp = tripData?.events.find(e => e.type === EventType.END)?.timestamp;
  const topSpeedEvent = tripData?.topSpeedEvent;
  
  // --- Enhanced Autocomplete State ---
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [suggestionsStatus, setSuggestionsStatus] = useState<string | null>(null);
  const [activeVehicleDropdown, setActiveVehicleDropdown] = useState<number | null>(null);
  const geocoder = useRef<any>(null);
  const autocompleteService = useRef<any>(null);
  const placesService = useRef<any>(null);
  const debounceTimer = useRef<number | null>(null);

  useEffect(() => {
    if (typeof google !== 'undefined' && !geocoder.current) {
        geocoder.current = new google.maps.Geocoder();
    }
    if (typeof google !== 'undefined' && !autocompleteService.current) {
        autocompleteService.current = new google.maps.places.AutocompleteService();
    }
    if (typeof google !== 'undefined' && !placesService.current) {
        const temp = document.createElement('div');
        placesService.current = new google.maps.places.PlacesService(temp);
    }
  }, []);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    // Don't show dropdown or flicker for short queries
    if (!addressQuery || addressQuery.length < 3) {
        setSuggestions([]);
        setShowDropdown(false);
        setIsFetchingSuggestions(false);
        setSuggestionsStatus(null);
        return;
    }

    // Debounce to prevent flickering and excessive API calls
    debounceTimer.current = window.setTimeout(async () => {
        setIsFetchingSuggestions(true);

        const request = {
            input: addressQuery,
            componentRestrictions: { country: 'us' },
        };

        const handlePredictions = (predictions: any[] | null, status: any) => {
            setIsFetchingSuggestions(false);
            setSuggestionsStatus(status || null);
            if (status === google.maps.places.PlacesServiceStatus.OK && predictions && predictions.length > 0) {
                const mapped = predictions.slice(0, 5).map((p: any) => ({
                    place_id: p.place_id,
                    main_text: p.structured_formatting?.main_text || p.description,
                    secondary_text: p.structured_formatting?.secondary_text || '',
                    description: p.description,
                }));
                setSuggestions(mapped);
                setShowDropdown(true);
            } else {
                setSuggestions([]);
                setShowDropdown(addressQuery.length > 6);
            }
        };

        if (autocompleteService.current) {
            autocompleteService.current.getPlacePredictions(request, handlePredictions);
            return;
        }

        // Fallback to geocoder if Places is unavailable
        if (!geocoder.current) {
            setIsFetchingSuggestions(false);
            return;
        }
        geocoder.current.geocode({ address: addressQuery, componentRestrictions: { country: 'us' } }, (results: any[], status: any) => {
            setIsFetchingSuggestions(false);
            setSuggestionsStatus(status || null);
            if (status === 'OK' && results && results.length > 0) {
                const filtered = results.filter(r => !r.types?.includes('country'));
                const mapped = filtered.slice(0, 5).map(res => ({
                    place_id: res.place_id,
                    main_text: res.formatted_address.split(',')[0],
                    secondary_text: res.formatted_address.split(',').slice(1).join(',').trim(),
                    description: res.formatted_address,
                }));
                setSuggestions(mapped);
                setShowDropdown(mapped.length > 0);
            } else {
                setSuggestions([]);
                setShowDropdown(addressQuery.length > 6);
            }
        });
    }, 300);

    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [addressQuery]);

  const handleSuggestionClick = (suggestion: any) => {
      setShowDropdown(false);
      if (!placesService.current) return;
      setIsFetchingSuggestions(true);

      placesService.current.getDetails(
        { placeId: suggestion.place_id, fields: ['geometry', 'formatted_address', 'name'] },
        (place: any, status: any) => {
            setIsFetchingSuggestions(false);
            if (status === google.maps.places.PlacesServiceStatus.OK && place?.geometry?.location) {
                const location: SearchedLocation = {
                    lat: place.geometry.location.lat(),
                    lng: place.geometry.location.lng(),
                    displayName: place.formatted_address || suggestion.description || suggestion.main_text,
                };
                onLocationSelect(location);
            } else {
                setSearchError("Could not load place details. Try again.");
            }
        }
      );
  };

  const getVehicleOptionsForInput = (value: string) => {
    const query = value.trim().toUpperCase();
    if (!query) return vehicleOptions;
    return vehicleOptions.filter(v => v.includes(query));
  };

  const calculateDuration = () => {
    if (!startTimeStamp || !endTimeStamp) return 'N/A';
    const durationMs = endTimeStamp - startTimeStamp;
    const hours = Math.floor(durationMs / 3600000);
    const minutes = Math.floor((durationMs % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  };

  const formatNavDuration = (seconds: number) => {
    if (seconds < 60) return `< 1 min`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  const handleQuickSelect = (period: 'morning' | 'afternoon' | 'last_hour' | 'last_20_minutes') => {
    const now = new Date(); let start = new Date(); let end = new Date();
    switch (period) {
        case 'morning': start.setHours(5, 0, 0, 0); end.setHours(10, 0, 0, 0); break;
        case 'afternoon': start.setHours(14, 0, 0, 0); end.setHours(18, 0, 0, 0); break;
        case 'last_hour': start.setTime(now.getTime() - 60 * 60 * 1000); end = now; break;
        case 'last_20_minutes': start.setTime(now.getTime() - 20 * 60 * 1000); end = now; break;
    }
    const format = (d: Date) => ({ date: d.toISOString().split('T')[0], time: d.toTimeString().split(' ')[0].substring(0, 5) });
    setStartDate(format(start).date); setStartTime(format(start).time);
    setEndDate(format(end).date); setEndTime(format(end).time);
  };
  
  const handleEventSelection = (timestamp: number) => {
    setSelectedEventTimestamp(timestamp);
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };


  return (
    <aside className={`fixed inset-y-0 left-0 z-[4020] w-full h-full bg-gray-900/80 backdrop-blur-sm border-r border-gray-700 flex flex-col shadow-2xl transform transition-transform duration-300 ease-in-out md:relative md:w-96 md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="p-4 border-b border-gray-700 flex justify-between items-start flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-cyan-400 tracking-wider">Tip Top Dispatch</h1>
            {!isGapiReady && (
              <div className="flex items-center space-x-2 text-sm text-gray-400 px-1 mt-2">
                  <SpinnerIcon className="w-4 h-4 animate-spin"/>
                  <span>Initializing Google Services...</span>
              </div>
            )}
        </div>
        <button onClick={() => setIsSidebarOpen(false)} className="md:hidden -mr-2 -mt-2 p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors">
            <CloseIcon className="w-7 h-7" />
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {sidebarView === 'main' ? (
          <>
            <div className="p-4 space-y-4 border-b border-gray-700 bg-gray-900/50">
                <div>
                    <div className="flex items-center justify-between mb-1">
                        <label htmlFor="fleet-0" className="block text-sm font-medium text-gray-300">Vehicle Number</label>
                    </div>
                    <div className="space-y-2">
                        {vehicleIds.map((vehicleId, index) => (
                            <div key={index} className="flex items-center gap-2 relative">
                                <span
                                    className="inline-block w-3 h-3 rounded-full border border-gray-200/60"
                                    style={{ backgroundColor: vehicleMarkerColors[index] || '#facc15' }}
                                    title={`Vehicle ${index + 1} marker color`}
                                />
                                <input
                                    type="text"
                                    id={`fleet-${index}`}
                                    value={vehicleId}
                                    onChange={e => onVehicleIdChange(index, e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleFetchCurrentLocation(); }}
                                    onFocus={() => setActiveVehicleDropdown(index)}
                                    onBlur={() => setTimeout(() => setActiveVehicleDropdown(prev => prev === index ? null : prev), 100)}
                                    className="flex-1 bg-gray-800 border border-gray-600 rounded-md px-3 py-2 text-white text-base focus:ring-cyan-500 focus:border-cyan-500"
                                    placeholder={`e.g. ${index === 0 ? '157' : '205'}`}
                                />
                                {index === 0 && (
                                    <button
                                        onClick={onAddVehicleId}
                                        disabled={vehicleIds.length >= 5}
                                        className="w-8 h-8 rounded-md border border-gray-600 bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                        title="Add another vehicle (max 5)"
                                    >
                                        +
                                    </button>
                                )}
                                {index > 0 && (
                                    <button
                                        onClick={() => onRemoveVehicleId(index)}
                                        className="w-8 h-8 rounded-md border border-gray-600 bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                                        title="Remove vehicle input"
                                    >
                                        <CloseIcon className="w-4 h-4 mx-auto" />
                                    </button>
                                )}
                                {activeVehicleDropdown === index && vehicleOptions.length > 0 && (
                                    <div className="absolute left-5 right-10 top-full mt-1 z-[6100] bg-gray-800 border border-gray-600 rounded-md shadow-xl max-h-96 overflow-y-auto custom-scrollbar">
                                        {getVehicleOptionsForInput(vehicleId).map((option) => (
                                            <button
                                                key={`${index}-${option}`}
                                                type="button"
                                                onMouseDown={(e) => {
                                                    e.preventDefault();
                                                    onVehicleSelectAndLocate(index, option);
                                                    setActiveVehicleDropdown(null);
                                                }}
                                                className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
                                            >
                                                {option}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    <div className="mt-3">
                        <button onClick={handleFetchCurrentLocation} disabled={isFetchingCurrentLocation} className="w-full flex items-center justify-center text-sm bg-gray-700 hover:bg-gray-600 text-gray-100 py-2 px-3 rounded-md transition-colors border border-gray-600 disabled:opacity-50">
                            {isFetchingCurrentLocation ? <SpinnerIcon className="w-4 h-4 animate-spin mr-2" /> : <LocateIcon className="w-4 h-4 mr-2" />}
                            Locate Vehicles
                        </button>
                    </div>
                    {currentLocationError && <p className="text-red-400 text-sm mt-2">{currentLocationError}</p>}
                    <button onClick={handleFetchAllVehicles} disabled={!isGapiReady || isFetchingAllVehicles} className="mt-3 w-full flex justify-center items-center text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 py-2 px-3 rounded-md transition-colors border border-gray-600 disabled:opacity-50">
                        {isFetchingAllVehicles && <SpinnerIcon className="w-4 h-4 animate-spin mr-2" />} View All Vehicles
                    </button>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                      <label htmlFor="address" className="block text-sm font-medium text-gray-300">Address Search</label>
                      <span className="text-[10px] text-gray-500 italic">Powered by Google</span>
                  </div>
                   <div className="relative z-[5000]">
                        <div className="relative overflow-hidden rounded-md border border-gray-600 bg-gray-800 focus-within:ring-1 focus-within:ring-cyan-500 focus-within:border-cyan-500 transition-all">
                             {/* Progressive Loading Line */}
                             {isFetchingSuggestions && <div className="absolute top-0 left-0 right-0 z-10 overflow-hidden"><div className="search-loading-bar"></div></div>}
                            
                            <input
                                type="text" id="address" value={addressQuery}
                                onChange={e => setAddressQuery(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleAddressSearch(); }}
                                placeholder="Search addresses..."
                                className="w-full bg-transparent px-3 py-2 text-white text-base placeholder-gray-500 outline-none pr-20"
                                autoComplete="off"
                            />
                            <div className="absolute inset-y-0 right-0 flex items-center pr-3 space-x-2">
                                {addressQuery && (
                                    <button onClick={handleClearSearch} className="text-gray-500 hover:text-white transition-colors">
                                        <CloseIcon className="w-5 h-5"/>
                                    </button>
                                )}
                                <button onClick={handleAddressSearch} disabled={isSearching} className="text-gray-400 hover:text-cyan-400 transition-colors disabled:text-gray-600">
                                    {isSearching ? <SpinnerIcon className="w-5 h-5 animate-spin" /> : <SearchIcon className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>

                        {showDropdown && (
                            <ul className="absolute left-0 right-0 top-full mt-2 bg-gray-800 border border-gray-600 rounded-md shadow-2xl max-h-72 overflow-y-auto custom-scrollbar z-[6000] animate-fade-in divide-y divide-gray-700">
                                {suggestions.length > 0 ? (
                                    suggestions.map((s, i) => (
                                        <li key={i} onClick={() => handleSuggestionClick(s)} className="px-4 py-3 hover:bg-gray-700 cursor-pointer group transition-colors">
                                            <p className="text-sm text-gray-100 font-semibold group-hover:text-cyan-400 transition-colors">{s.main_text}</p>
                                            <p className="text-xs text-gray-400 truncate mt-0.5">{s.secondary_text}</p>
                                        </li>
                                    ))
                                ) : (
                                    <li className="px-4 py-4 text-center text-gray-500 text-sm">
                                        No addresses found for this area
                                    </li>
                                )}
                            </ul>
                        )}
                        {addressQuery.length >= 3 && suggestionsStatus && suggestionsStatus !== 'OK' && (
                            <p className="text-[11px] text-gray-500 mt-2">Autocomplete status: {suggestionsStatus}</p>
                        )}
                    </div>
                  {searchError && <p className="text-red-400 text-sm mt-2">{searchError}</p>}
                </div>
            </div>
            
            <AccordionSection title="Vehicle Path History" isOpen={true}>
                <div className="p-4 bg-gray-900/30">
                    <div className="space-y-4">
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-2 uppercase">Quick Select</label>
                            <div className="grid grid-cols-2 gap-2">
                                <button onClick={() => handleQuickSelect('morning')} className="px-2 py-1.5 text-xs font-semibold bg-gray-800 text-gray-300 rounded border border-gray-700 hover:bg-gray-700 transition-colors">This Morning</button>
                                <button onClick={() => handleQuickSelect('afternoon')} className="px-2 py-1.5 text-xs font-semibold bg-gray-800 text-gray-300 rounded border border-gray-700 hover:bg-gray-700 transition-colors">This Afternoon</button>
                                <button onClick={() => handleQuickSelect('last_hour')} className="px-2 py-1.5 text-xs font-semibold bg-gray-800 text-gray-300 rounded border border-gray-700 hover:bg-gray-700 transition-colors">Last Hour</button>
                                <button onClick={() => handleQuickSelect('last_20_minutes')} className="px-2 py-1.5 text-xs font-semibold bg-gray-800 text-gray-300 rounded border border-gray-700 hover:bg-gray-700 transition-colors">Last 20 Mins</button>
                            </div>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">Start</label>
                            <div className="flex items-center space-x-2">
                                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{colorScheme: 'dark'}} className="w-full bg-gray-800 border border-gray-600 rounded-md px-3 py-2 text-white text-sm" />
                                <TimePicker value={startTime} onChange={setStartTime} />
                            </div>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1 uppercase">End</label>
                            <div className="flex items-center space-x-2">
                                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{colorScheme: 'dark'}} className="w-full bg-gray-800 border border-gray-600 rounded-md px-3 py-2 text-white text-sm" />
                                <TimePicker value={endTime} onChange={setEndTime} />
                            </div>
                        </div>
                        <button onClick={handleFetch} disabled={isLoading} className="w-full flex justify-center items-center bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-2.5 px-4 rounded-md transition duration-300 disabled:bg-gray-600">
                            {isLoading ? <SpinnerIcon className="w-5 h-5 animate-spin" /> : "View Vehicle Path"}
                        </button>
                    </div>
                </div>
            </AccordionSection>

            <AccordionSection title="Planned Routes" isOpen={false}>
                 <div className="p-4 bg-gray-900/30">
                     <button onClick={handleFetchRoutes} disabled={!isGapiReady || isFetchingRoutes} className="w-full flex justify-center items-center bg-teal-700 hover:bg-teal-600 text-white font-bold py-2 px-4 rounded-md transition duration-300 disabled:bg-gray-600">
                        {isFetchingRoutes ? <SpinnerIcon className="w-5 h-5 animate-spin" /> : <RouteIcon className="w-5 h-5" />}
                        <span className="ml-2">View Routes</span>
                    </button>
                </div>
            </AccordionSection>

            {tripData && (
                <AccordionSection title="Trip Summary & Events" isOpen={true}>
                     <div className="p-4 bg-gray-900/30">
                        <div className="space-y-2 text-sm mb-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
                            <div className="flex justify-between"><span className="text-gray-400">Duration:</span><span className="text-gray-200 font-mono">{calculateDuration()}</span></div>
                            {topSpeedEvent && (<div className="flex justify-between rounded transition-colors hover:bg-gray-700/50 cursor-pointer" onMouseEnter={() => setHoveredEventTimestamp(topSpeedEvent.timestamp)} onMouseLeave={() => setHoveredEventTimestamp(null)} onClick={() => handleEventSelection(topSpeedEvent.timestamp)}><span className="text-gray-400">Top Speed:</span><span className="text-gray-200 font-mono font-bold text-yellow-400">{topSpeedEvent.speed.toFixed(1)} mph</span></div>)}
                        </div>
                        <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Event Log</h4>
                        <div className="space-y-2 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
                        {tripData.events.map((event, index) => (
                            <div key={index} className="flex items-start space-x-3 p-2 rounded-lg transition-colors hover:bg-gray-800 cursor-pointer border border-transparent hover:border-gray-700" onMouseEnter={() => setHoveredEventTimestamp(event.timestamp)} onMouseLeave={() => setHoveredEventTimestamp(null)} onClick={() => handleEventSelection(event.timestamp)}>
                                <div className="mt-1 flex-shrink-0">{getEventIcon(event.type)}</div>
                                <div><p className="font-semibold text-gray-200 text-sm">{event.type}</p><p className="text-xs text-gray-400">{event.details}</p></div>
                            </div>
                        ))}
                        </div>
                    </div>
                </AccordionSection>
            )}
          </>
        ) : (
          <div className="p-4 animate-fade-in flex flex-col h-full">
                <div className="flex items-center mb-4">
                    <button onClick={handleBackToMainView} className="p-1 mr-3 -ml-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"><ArrowLeftIcon className="w-5 h-5" /></button>
                    <h2 className="text-lg font-semibold text-gray-200">Routes for <span className="font-bold text-cyan-400">{fleet}</span></h2>
                </div>
                <div className="space-y-2">
                {routes?.map((route) => (
                    <button key={route.id} onClick={() => handleSelectRoute(route)} className={`w-full flex items-center p-3 rounded-lg text-left transition-colors ${selectedRoute?.id === route.id ? 'bg-teal-800/70 border border-teal-600' : 'bg-gray-800/60 hover:bg-gray-700 border border-transparent'}`}>
                        {isFetchingRouteDetails && selectedRoute?.id === route.id ? <SpinnerIcon className="w-5 h-5 mr-4 text-teal-400 animate-spin" /> : <RouteIcon className="w-5 h-5 mr-4 text-teal-400" />}
                        <span className="text-gray-200 flex-1 truncate text-sm font-medium">{route.name}</span>
                    </button>
                ))}
                </div>
            {selectedRouteStops && (
                <div className="mt-4 pt-4 border-t border-gray-700 flex-1 flex flex-col min-h-0">
                    <h3 className="text-sm font-bold text-gray-400 uppercase mb-3 px-1">Stops List</h3>
                    <div className="overflow-y-auto space-y-1 pr-2 custom-scrollbar">
                        {selectedRouteStops.map(stop => (
                            <div key={stop.id} className={`p-2.5 rounded-lg transition-colors duration-150 cursor-pointer border ${hoveredRouteStopId === stop.id ? 'bg-gray-700 border-gray-600' : 'hover:bg-gray-800 border-transparent'}`} onMouseEnter={() => setHoveredRouteStopId(stop.id)} onMouseLeave={() => setHoveredRouteStopId(null)}>
                                <div className="flex items-center space-x-3">
                                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-500 flex items-center justify-center text-xs font-bold text-gray-900 shadow-sm">{stop.stopNumber}</div>
                                    <div className="flex-1 overflow-hidden">
                                        <p className="font-semibold text-gray-200 truncate text-sm">{stop.stopLocation || 'Stop'}</p>
                                        <p className="text-xs text-gray-400 truncate">{stop.studentName}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
