
export type Coordinate = [number, number]; // [latitude, longitude]

export interface PathPoint {
  lat: number;
  lng: number;
  timestamp: number;
  speed: number;
  heading: string;
}

export enum EventType {
  START = "Trip Start",
  STOP = "Stop",
  HARSH_BRAKING = "Harsh Braking",
  SPEEDING = "Speeding",
  END = "Trip End",
}

export interface VehicleEvent {
  type: EventType;
  timestamp: number;
  location: Coordinate;
  details: string;
}

export interface TopSpeedInfo {
  speed: number;
  timestamp: number;
  location: Coordinate;
}

export interface TripData {
  vehicleId: string;
  driverName?: string;
  status: "In Transit" | "Stopped" | "Completed";
  path: PathPoint[];
  events: VehicleEvent[];
  topSpeedEvent?: TopSpeedInfo;
}

export interface SearchedLocation {
    lat: number;
    lng: number;
    displayName: string;
}

export interface CurrentLocationData {
    lat: number;
    lng: number;
    timestamp: number;
    speed: string;
    heading: string;
    power: string;
    fleet: string;
}

export interface DriveFile {
  id: string;
  name: string;
}

export interface RouteStop {
  id: number;
  stopNumber: string;
  time: string;
  stopLocation: string;
  studentName: string;
  contactName: string;
  phoneNumber: string;
  otherEquipment: string;
  latitude: number;
  longitude: number;
}

export interface NavigationData {
  path: Coordinate[];
  duration: number; // in seconds
  distance?: string;
}
