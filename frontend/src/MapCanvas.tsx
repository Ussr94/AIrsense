import { useEffect } from 'react'
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

export type MapStation = {
  station: string
  latitude: number
  longitude: number
  distance_km: number
  readings: Array<{ parameter: string; units: string | null; value: number; datetime: string | null }>
}

export type MapRoute = {
  id: number
  distance: number
  duration: number
  coordinates: [number, number][]
}

type MapCanvasProps = {
  center: [number, number]
  stations: MapStation[]
  routes: MapRoute[]
  selectedRoute: number | null
  origin: { label: string; latitude: number; longitude: number } | null
  destination: { label: string; latitude: number; longitude: number } | null
}

function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap()

  useEffect(() => {
    map.setView(center, Math.max(map.getZoom(), 11), { animate: true })
  }, [center[0], center[1], map])

  useEffect(() => {
    const element = map.getContainer()
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(element)
    return () => observer.disconnect()
  }, [map])

  return null
}

function RouteBounds({ routes, selectedRoute }: { routes: MapRoute[]; selectedRoute: number | null }) {
  const map = useMap()
  const route = routes.find((item) => item.id === selectedRoute)

  useEffect(() => {
    if (!route || route.coordinates.length < 2) return
    const points = route.coordinates.map(([longitude, latitude]) => [latitude, longitude] as [number, number])
    map.fitBounds(points, { padding: [36, 36], maxZoom: 13 })
  }, [map, route])

  return null
}

export default function MapCanvas({ center, stations, routes, selectedRoute, origin, destination }: MapCanvasProps) {
  return (
    <MapContainer className="map-canvas" center={center} zoom={11} scrollWheelZoom>
      <MapUpdater center={center} />
      <RouteBounds routes={routes} selectedRoute={selectedRoute} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {routes.map((route) => (
        <Polyline
          key={route.id}
          positions={route.coordinates.map(([longitude, latitude]) => [latitude, longitude] as [number, number])}
          pathOptions={{ color: route.id === selectedRoute ? '#d45a3f' : '#3879bd', weight: route.id === selectedRoute ? 6 : 4, opacity: route.id === selectedRoute ? 0.9 : 0.65 }}
        >
          <Popup>{`Route ${route.id + 1} · ${(route.distance / 1000).toFixed(1)} km`}</Popup>
        </Polyline>
      ))}
      {stations.map((station) => {
        const pm25 = station.readings.find((reading) => reading.parameter === 'pm25')
        return (
          <CircleMarker key={`${station.station}-${station.latitude}`} center={[station.latitude, station.longitude]} radius={8} pathOptions={{ color: '#ffffff', weight: 2, fillColor: pm25 && pm25.value >= 50 ? '#cf5548' : pm25 && pm25.value >= 25 ? '#dfa63c' : '#4b9b69', fillOpacity: 0.95 }}>
            <Popup>{station.station}<br />{station.distance_km} km from selected city<br />{pm25 ? `PM2.5 ${pm25.value.toFixed(1)} ${pm25.units || 'µg/m³'}` : 'No PM2.5 value reported'}</Popup>
          </CircleMarker>
        )
      })}
      {origin && <CircleMarker center={[origin.latitude, origin.longitude]} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#27775f', fillOpacity: 1 }}><Popup>{`Trip A · ${origin.label}`}</Popup></CircleMarker>}
      {destination && <CircleMarker center={[destination.latitude, destination.longitude]} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#5d66b1', fillOpacity: 1 }}><Popup>{`Trip B · ${destination.label}`}</Popup></CircleMarker>}
    </MapContainer>
  )
}
