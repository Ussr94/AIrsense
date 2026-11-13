import { useEffect, useState, type FormEvent } from 'react'
import MapCanvas, { type MapRoute, type MapStation } from './MapCanvas'
import './App.css'

type ApiState = 'checking' | 'online' | 'offline'
type AirReading = { parameter: string; units: string | null; value: number; datetime: string | null; station: string }
type WeatherSummary = { location: string; temperature_c: number | null; description: string | null; humidity_pct: number | null; wind_speed_m_s: number | null; observed_at: string; stored: number }
type Coordinates = { latitude: number; longitude: number }
type TrendPoint = { time: string; value: number }
type TripPlace = { label: string; latitude: number; longitude: number }
type RouteAirSummary = { route_index: number; sample_count: number; measured_count: number; mean_pm25: number | null }

function App() {
  const [apiState, setApiState] = useState<ApiState>('checking')
  const [influxState, setInfluxState] = useState<ApiState>('checking')
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null)
  const [mapCenter, setMapCenter] = useState<Coordinates | null>(null)
  const [airReadings, setAirReadings] = useState<AirReading[]>([])
  const [areaStations, setAreaStations] = useState<MapStation[]>([])
  const [areaRadius, setAreaRadius] = useState('10000')
  const [areaLoading, setAreaLoading] = useState(false)
  const [areaMessage, setAreaMessage] = useState('')
  const [trendPoints, setTrendPoints] = useState<TrendPoint[]>([])
  const [openaqConfigured, setOpenAQConfigured] = useState<boolean | null>(null)
  const [weatherConfigured, setWeatherConfigured] = useState<boolean | null>(null)
  const [tripFrom, setTripFrom] = useState('')
  const [tripTo, setTripTo] = useState('')
  const [tripStart, setTripStart] = useState<TripPlace | null>(null)
  const [tripEnd, setTripEnd] = useState<TripPlace | null>(null)
  const [tripRoutes, setTripRoutes] = useState<MapRoute[]>([])
  const [selectedRoute, setSelectedRoute] = useState<number | null>(null)
  const [routeAirSummary, setRouteAirSummary] = useState<RouteAirSummary[]>([])
  const [tripLoading, setTripLoading] = useState(false)
  const [tripMessage, setTripMessage] = useState('')
  const [mapFullscreen, setMapFullscreen] = useState(false)
  const [mapFallbackExpanded, setMapFallbackExpanded] = useState(false)
  const [airStation, setAirStation] = useState('')
  const [airStationCoordinates, setAirStationCoordinates] = useState<{ latitude: number; longitude: number } | null>(null)
  const [airStationDistance, setAirStationDistance] = useState<number | null>(null)
  const [airLoading, setAirLoading] = useState(false)
  const [airMessage, setAirMessage] = useState('')
  const [weather, setWeather] = useState<WeatherSummary | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)
  const [weatherMessage, setWeatherMessage] = useState('')
  const [location, setLocation] = useState('Bengaluru, India')
  const [locationInput, setLocationInput] = useState('Bengaluru, India')
  const [locationMessage, setLocationMessage] = useState('')

  useEffect(() => {
    const handleFullscreenChange = () => setMapFullscreen(document.fullscreenElement?.id === 'map')
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    fetch('http://127.0.0.1:8000/health')
      .then((response) => {
        if (!response.ok) throw new Error('API is unavailable')
        return response.json()
      })
      .then(() => setApiState('online'))
      .catch(() => setApiState('offline'))

    fetch('http://127.0.0.1:8000/health/influxdb')
      .then((response) => {
        if (!response.ok) throw new Error('InfluxDB is unavailable')
        return response.json()
      })
      .then(() => setInfluxState('online'))
      .catch(() => setInfluxState('offline'))

    fetch('http://127.0.0.1:8000/health/connections')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Connection status unavailable')))
      .then((body) => {
        setOpenAQConfigured(Boolean(body.openaq_configured))
        setWeatherConfigured(Boolean(body.weather_configured))
      })
      .catch(() => {
        setOpenAQConfigured(false)
        setWeatherConfigured(false)
      })
  }, [])

  async function saveLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextLocation = locationInput.trim()
    if (!nextLocation) return
    setLocationMessage('Looking up that place…')
    try {
      const response = await fetch(`http://127.0.0.1:8000/api/geocode?name=${encodeURIComponent(nextLocation)}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Could not look up that place.')
      const place = body.results?.[0]
      if (!place) throw new Error(body.message || 'Place not found. Try adding the city and state.')
      const displayName = [place.name, place.admin1, place.country].filter(Boolean).join(', ')
      setLocation(displayName)
      setLocationInput(displayName)
      setCoordinates({ latitude: place.latitude, longitude: place.longitude })
      setMapCenter({ latitude: place.latitude, longitude: place.longitude })
      setLocationMessage('Location found. You can now load nearby air readings.')
      setAirReadings([])
      setAreaStations([])
      setTrendPoints([])
      setAirStation('')
      setAirStationCoordinates(null)
      setAirStationDistance(null)
      setAirMessage('')
      setWeather(null)
      setWeatherMessage('')
    } catch (error) {
      setCoordinates(null)
      setLocationMessage(error instanceof Error ? error.message : 'Could not look up that place.')
    }
  }

  function useCurrentLocation() {
    setLocationMessage('')
    if (!navigator.geolocation) {
      setLocationMessage('Location is not available in this browser.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const coordinates = coords.latitude.toFixed(3) + ', ' + coords.longitude.toFixed(3)
        const point = { latitude: coords.latitude, longitude: coords.longitude }
        setCoordinates(point)
        setMapCenter(point)
        setLocation(coordinates)
        setLocationInput(coordinates)
        setLocationMessage('Current coordinates loaded. You can now look for nearby air readings.')
        setAirReadings([])
        setAreaStations([])
        setTrendPoints([])
        setAirStation('')
        setAirStationCoordinates(null)
        setAirStationDistance(null)
        setAirMessage('')
        setWeather(null)
        setWeatherMessage('')
      },
      () => setLocationMessage('Location permission was not available. You can enter a place above.'),
    )
  }

  async function loadNearbyAir() {
    if (!coordinates) {
      setAirMessage('Choose “Use my location” first so we can search near you.')
      return
    }
    setAirLoading(true)
    setAirMessage('Searching OpenAQ for a nearby monitoring station…')
    try {
      const params = new URLSearchParams({
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
        radius: areaRadius,
      })
      const response = await fetch(`http://127.0.0.1:8000/api/openaq/nearby?${params}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Could not load air-quality readings.')
      setAirReadings(body.readings || [])
      setAirStation(body.station || '')
      setAirStationCoordinates(body.station_coordinates || null)
      setAirStationDistance(body.distance_km ?? null)
      setAirMessage(body.message || `${body.stored} readings saved to InfluxDB.`)
      setAreaMessage('')
      try {
        const historyResponse = await fetch(`http://127.0.0.1:8000/api/readings?start=-7d&location=${encodeURIComponent(body.station || '')}`)
        if (historyResponse.ok) {
          const historyBody = await historyResponse.json()
          const points = (historyBody.readings || [])
            .filter((row: Record<string, string>) => row._measurement === 'air_quality' && row._field === 'pm25' && Number.isFinite(Number(row._value)))
            .map((row: Record<string, string>) => ({ time: row._time, value: Number(row._value) }))
            .filter((point: TrendPoint) => Boolean(point.time))
            .sort((a: TrendPoint, b: TrendPoint) => Date.parse(a.time) - Date.parse(b.time))
          setTrendPoints(points.slice(-24))
        }
      } catch {
        setTrendPoints([])
      }
    } catch (error) {
      setAirMessage(error instanceof Error ? error.message : 'Could not load air-quality readings.')
    } finally {
      setAirLoading(false)
    }
  }

  async function loadAreaStations() {
    if (!coordinates) {
      setAreaMessage('Enter a city or use your location first.')
      return
    }
    setAreaLoading(true)
    setAreaMessage('Looking for monitoring stations around this city…')
    try {
      const params = new URLSearchParams({
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
        radius: areaRadius,
      })
      const response = await fetch(`http://127.0.0.1:8000/api/openaq/area?${params}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Could not load nearby station data.')
      const stations: MapStation[] = body.stations || []
      setAreaStations(stations)
      setAreaMessage(stations.length ? `${stations.length} nearby stations found within ${Number(areaRadius) / 1000} km. Their readings were saved to InfluxDB.` : 'No monitoring stations with coordinates were found in this area.')
    } catch (error) {
      setAreaMessage(error instanceof Error ? error.message : 'Could not load nearby station data.')
    } finally {
      setAreaLoading(false)
    }
  }

  async function lookupTripPlace(query: string): Promise<TripPlace> {
    const response = await fetch(`http://127.0.0.1:8000/api/geocode?name=${encodeURIComponent(query)}`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.detail || `Could not find ${query}.`)
    const place = body.results?.[0]
    if (!place) throw new Error(body.message || `Could not find “${query}”. Add the full landmark and city, for example “Pune Junction railway station, Pune”.`)
    return {
      label: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      latitude: place.latitude,
      longitude: place.longitude,
    }
  }

  async function planTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!tripFrom.trim() || !tripTo.trim()) {
      setTripMessage('Enter both Trip A and Trip B.')
      return
    }
    setTripLoading(true)
    setTripMessage('Finding the places and route options…')
    setTripRoutes([])
    setRouteAirSummary([])
    try {
      const start = await lookupTripPlace(tripFrom.trim())
      const end = await lookupTripPlace(tripTo.trim())
      const routeParams = new URLSearchParams({
        from_latitude: String(start.latitude),
        from_longitude: String(start.longitude),
        to_latitude: String(end.latitude),
        to_longitude: String(end.longitude),
      })
      const routeResponse = await fetch(`http://127.0.0.1:8000/api/routes?${routeParams}`)
      const routeBody = await routeResponse.json()
      if (!routeResponse.ok || !routeBody.routes?.length) {
        throw new Error('No driving route was found between those places. Try a nearby landmark or full city name.')
      }
      const routes: MapRoute[] = routeBody.routes.map((route: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }, id: number) => ({
        id,
        distance: route.distance,
        duration: route.duration,
        coordinates: route.geometry.coordinates,
      }))
      setTripStart(start)
      setTripEnd(end)
      setTripRoutes(routes)
      setSelectedRoute(0)
      setMapCenter({ latitude: start.latitude, longitude: start.longitude })
      setTripMessage(`${routes.length} route option${routes.length === 1 ? '' : 's'} found. Checking nearby air-quality stations along the route…`)

      const samplePayload = routes.flatMap((route) => [0.15, 0.5, 0.85].map((fraction) => {
        const pointIndex = Math.min(route.coordinates.length - 1, Math.round((route.coordinates.length - 1) * fraction))
        const [longitude, latitude] = route.coordinates[pointIndex]
        return { route_index: route.id, latitude, longitude }
      }))
      try {
        const airResponse = await fetch('http://127.0.0.1:8000/api/openaq/route-readings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ samples: samplePayload }),
        })
        const airBody = await airResponse.json()
        if (airResponse.ok) {
          const summaries: RouteAirSummary[] = airBody.routes || []
          setRouteAirSummary(summaries)
          const routeStations: MapStation[] = (airBody.samples || [])
            .filter((sample: { station: string | null; latitude: number | null; longitude: number | null; pm25: number | null }) => sample.station && sample.latitude !== null && sample.longitude !== null && sample.pm25 !== null)
            .map((sample: { station: string; latitude: number; longitude: number; distance_km: number; pm25: number; units: string | null }) => ({
              station: sample.station,
              latitude: sample.latitude,
              longitude: sample.longitude,
              distance_km: sample.distance_km,
              readings: [{ parameter: 'pm25', units: sample.units, value: sample.pm25, datetime: null }],
            }))
          setAreaStations((current) => [...new Map([...current, ...routeStations].map((station) => [station.station, station])).values()])
          const comparable = summaries.filter((summary) => summary.measured_count >= 2 && summary.mean_pm25 !== null)
          if (comparable.length >= 2) {
            const cleaner = [...comparable].sort((a, b) => (a.mean_pm25 ?? Infinity) - (b.mean_pm25 ?? Infinity))[0]
            setSelectedRoute(cleaner.route_index)
            setTripMessage(`Route ${cleaner.route_index + 1} has the lower average PM2.5 at the sampled monitoring stations. Coverage is limited; this cannot guarantee cleaner air along the whole route.`)
          } else if (comparable.length === 1) {
            setTripMessage('Some monitoring data was found, but there is not enough coverage to compare route pollution. Route options are shown by travel time and distance.')
          } else {
            setTripMessage('Routes found, but nearby PM2.5 measurements are unavailable along them. Route options are shown by travel time and distance.')
          }
        } else {
          setTripMessage('Routes found. OpenAQ route measurements could not be loaded, so options are shown by travel time and distance.')
        }
      } catch {
        setTripMessage('Routes found. Route pollution data is unavailable right now; options are shown by travel time and distance.')
      }
    } catch (error) {
      setTripMessage(error instanceof Error ? error.message : 'Could not plan that trip.')
    } finally {
      setTripLoading(false)
    }
  }

  function openMapFullscreen() {
    const mapPanel = document.getElementById('map')
    mapPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (mapPanel?.requestFullscreen) {
      void mapPanel.requestFullscreen().catch(() => setMapFallbackExpanded(true))
    } else {
      setMapFallbackExpanded(true)
    }
  }

  function closeMapFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    setMapFallbackExpanded(false)
  }

  async function loadWeather() {
    if (!coordinates) {
      setWeatherMessage('Set a place above first so we know which weather to load.')
      return
    }
    setWeatherLoading(true)
    setWeatherMessage('Loading current weather…')
    try {
      const params = new URLSearchParams({
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
      })
      const response = await fetch(`http://127.0.0.1:8000/api/weather?${params}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Could not load weather.')
      setWeather(body)
      setWeatherMessage(`${body.stored} weather readings saved to InfluxDB.`)
    } catch (error) {
      setWeatherMessage(error instanceof Error ? error.message : 'Could not load weather.')
    } finally {
      setWeatherLoading(false)
    }
  }

  const pm25Reading = airReadings.find((reading) => reading.parameter.toLowerCase() === 'pm25')
  const hasLocalData = airReadings.length > 0 || weather !== null
  const outdoorGuidance = !pm25Reading
    ? { level: 'waiting', title: 'Waiting for a PM2.5 reading', message: 'Load nearby air readings to get a local outdoor activity suggestion.' }
    : pm25Reading.value >= 75
      ? { level: 'high', title: 'High PM2.5 snapshot — avoid outdoor exercise if possible', message: 'Consider moving strenuous activity indoors. If going outside is necessary, keep it brief and less intense; sensitive groups should take extra care.' }
      : pm25Reading.value >= 35
        ? { level: 'moderate', title: 'Elevated PM2.5 snapshot — reduce strenuous activity', message: 'Consider a shorter, less intense outdoor activity, especially if you are sensitive to air pollution.' }
        : { level: 'low', title: 'Lower PM2.5 snapshot', message: 'This single reading is lower, but conditions can change. Check your local official AQI before planning strenuous activity.' }
  const comparableRoutes = routeAirSummary.filter((route) => route.measured_count >= 2 && route.mean_pm25 !== null)
  const recommendedRouteId = comparableRoutes.length >= 2
    ? [...comparableRoutes].sort((a, b) => (a.mean_pm25 ?? Infinity) - (b.mean_pm25 ?? Infinity))[0].route_index
    : tripRoutes.length > 0 ? [...tripRoutes].sort((a, b) => a.duration - b.duration)[0].id : null
  const fastestRouteId = tripRoutes.length > 0 ? [...tripRoutes].sort((a, b) => a.duration - b.duration)[0].id : null
  const displayedTripRoutes = [...tripRoutes].sort((a, b) => (a.id === recommendedRouteId ? -1 : 0) - (b.id === recommendedRouteId ? -1 : 0) || a.duration - b.duration)
  const mapDisplayCenter = mapCenter || coordinates
  const fullMapUrl = mapDisplayCenter
    ? `https://www.openstreetmap.org/?mlat=${mapDisplayCenter.latitude}&mlon=${mapDisplayCenter.longitude}#map=13/${mapDisplayCenter.latitude}/${mapDisplayCenter.longitude}`
    : 'https://www.openstreetmap.org/'

  const trendChart = trendPoints.length > 1
    ? trendPoints.map((point, index) => {
        const values = trendPoints.map((item) => item.value)
        const min = Math.min(...values)
        const max = Math.max(...values)
        const spread = max - min || 1
        const x = 24 + (index / (trendPoints.length - 1)) * 592
        const y = 150 - ((point.value - min) / spread) * 112
        return `${x},${y}`
      }).join(' ')
    : ''

  const dateLabel = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date())

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Infoy home">
          <span className="brand-mark">i</span>
          <span>infoy<span className="brand-period">.</span></span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-item active" href="#overview"><span className="nav-icon">◫</span> Overview</a>
          <a className="nav-item" href="#guidance"><span className="nav-icon">✳</span> Guidance</a>
          <a className="nav-item" href="#air-quality"><span className="nav-icon">◌</span> Air quality</a>
          <a className="nav-item" href="#trends"><span className="nav-icon">⌁</span> Trends</a>
          <a className="nav-item" href="#weather"><span className="nav-icon">☼</span> Weather</a>
          <a className="nav-item" href="#map" onClick={() => openMapFullscreen()}><span className="nav-icon">⌖</span> Map</a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-card">
            <span className="sidebar-card-icon">✳</span>
            <strong>Your environment, at a glance</strong>
            <p>Air and weather insights for healthier everyday choices.</p>
          </div>
          <div className="profile-row">
            <span className="avatar">I</span>
            <span><strong>Personal workspace</strong><small>Local preview</small></span>
            <span className="profile-dots">···</span>
          </div>
        </div>
      </aside>

      <main className="main-area" id="overview">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-divider">/</span><strong>Overview</strong></div>
          <div className="topbar-right">
            <span className="date-label">{dateLabel}</span>
            <span className={'api-pill ' + apiState}><span className="status-dot" />{apiState === 'checking' ? 'Checking API' : apiState === 'online' ? 'Backend connected' : 'Backend offline'}</span>
            <span className={'api-pill ' + influxState}><span className="status-dot" />{influxState === 'checking' ? 'Checking database' : influxState === 'online' ? 'InfluxDB connected' : 'InfluxDB offline'}</span>
          </div>
        </header>

        <div className="page-content">
          <section className="welcome-row" id="overview">
            <div>
              <p className="eyebrow">YOUR LOCAL ENVIRONMENT</p>
              <h1>Environmental overview</h1>
              <p className="subheading">A clearer picture of the air and conditions around you.</p>
            </div>
            <div className="today-badge"><span className="sun-symbol">☼</span><span><strong>Today</strong><small>Daily snapshot</small></span></div>
          </section>

          <section className="location-panel" aria-label="Monitoring location">
            <div className="location-title">
              <span className="location-pin">⌖</span>
              <div><span className="field-label">MONITORING LOCATION</span><h2>{location}</h2></div>
            </div>
            <form className="location-form" onSubmit={saveLocation}>
              <label className="sr-only" htmlFor="location-input">Enter a city or location</label>
              <input id="location-input" value={locationInput} onChange={(event) => setLocationInput(event.target.value)} placeholder="Enter a city or location" />
              <button className="button button-dark" type="submit">Set location</button>
              <button className="button button-light" type="button" onClick={useCurrentLocation}>Use my location</button>
            </form>
            {locationMessage && <p className="location-message" role="status">{locationMessage}</p>}
          </section>

          <section className="summary-grid" aria-label="Environmental summary">
            <article className="metric-card air-card" id="air-quality">
              <div className="metric-top"><span className="metric-label">PM2.5 CONCENTRATION</span><span className="metric-icon air-icon">◌</span></div>
              <div className="metric-value">{pm25Reading ? pm25Reading.value.toFixed(1) : '--'} <span className="metric-unit">{pm25Reading?.units || 'PM2.5'}</span></div>
              <p className="metric-note">{pm25Reading ? 'Latest PM2.5 concentration' : 'No nearby PM2.5 reading loaded yet'}</p>
              <div className="metric-footer"><span className="mini-status" /> {airStation || 'OpenAQ readings will be saved in InfluxDB'}</div>
              <button className="button button-dark air-load-button" type="button" onClick={loadNearbyAir} disabled={airLoading}>{airLoading ? 'Loading readings…' : 'Load nearby air readings'}</button>
              {airMessage && <p className="location-message" role="status">{airMessage}</p>}
            </article>
            <article className="metric-card weather-card" id="weather">
              <div className="metric-top"><span className="metric-label">WEATHER</span><span className="metric-icon weather-icon">☼</span></div>
              <div className="metric-value">{weather?.temperature_c !== null && weather?.temperature_c !== undefined ? weather.temperature_c.toFixed(1) : '--'}<span className="metric-unit">°C</span></div>
              <p className="metric-note">{weather?.description || 'Current conditions will appear here'}</p>
              <div className="metric-footer"><span className="mini-status" />{weather ? `${weather.location} · humidity ${weather.humidity_pct ?? '--'}%` : 'OpenWeatherMap connection pending'}</div>
              <button className="button button-dark air-load-button" type="button" onClick={loadWeather} disabled={weatherLoading}>{weatherLoading ? 'Loading weather…' : 'Load current weather'}</button>
              {weatherMessage && <p className="location-message" role="status">{weatherMessage}</p>}
            </article>
            <article className="metric-card exposure-card" id="guidance">
              <div className="metric-top"><span className="metric-label">OUTDOOR GUIDANCE</span><span className="metric-icon guidance-icon">✳</span></div>
              <div className={`guidance-title guidance-${outdoorGuidance.level}`}>{outdoorGuidance.title}</div>
              <p className="guidance-message">{outdoorGuidance.message}</p>
              <p className="guidance-caveat">Based on one latest PM2.5 sensor reading, not an official AQI or 24-hour average. Follow local public-health guidance.</p>
              <div className="metric-footer"><span className="mini-status" />{hasLocalData ? 'Based on the latest available reading' : 'Based on your selected location'}</div>
            </article>
          </section>

          <section className="content-grid">
            <article className="panel pollutant-panel">
              <div className="panel-heading"><div><p className="eyebrow">AIR QUALITY</p><h2>Pollutant levels</h2></div><span className="panel-chip">{airReadings.length ? 'Latest from OpenAQ' : 'Live readings pending'}</span></div>
              <div className="pollutant-list">
                {[
                  ['PM2.5', 'Fine particles'],
                  ['PM10', 'Coarse particles'],
                  ['NO₂', 'Nitrogen dioxide'],
                  ['O₃', 'Ozone'],
                  ['CO', 'Carbon monoxide'],
                ].map(([name, description]) => (
                  (() => {
                    const key = name === 'PM2.5' ? 'pm25' : name === 'PM10' ? 'pm10' : name === 'NO₂' ? 'no2' : name === 'O₃' ? 'o3' : 'co'
                    const reading = airReadings.find((item) => item.parameter.toLowerCase() === key)
                    const scale = key === 'pm25' ? 75 : key === 'pm10' ? 250 : key === 'no2' ? 200 : key === 'o3' ? 200 : 10
                    const level = reading ? Math.min(1, Math.max(0, reading.value / scale)) : 0
                    const band = level < 0.34 ? 'low' : level < 0.67 ? 'moderate' : 'high'
                    return (
                  <div className="pollutant-row" key={name}>
                    <span className="pollutant-name"><strong>{name}</strong><small>{description}</small></span>
                    <span className="reading-placeholder">{reading ? reading.value.toFixed(2) : '--'} <small>{reading?.units || 'µg/m³'}</small></span>
                    <span className="reading-track"><i className={reading ? band : ''} style={{ width: reading ? `${Math.max(4, level * 100)}%` : '0%' }} /></span>
                  </div>
                    )
                  })()
                ))}
              </div>
              <div className="panel-footnote">{airReadings.length ? `Showing ${airReadings.length} latest readings from ${airStation}; saved to InfluxDB. Bar colors are visual bands, not official AQI ratings.` : 'Readings will be shown with units, source, and collection time.'}</div>
            </article>

            <article className={`panel map-panel${mapFallbackExpanded ? ' map-expanded' : ''}`} id="map">
              <div className="panel-heading"><div><p className="eyebrow">YOUR AREA & ROUTES</p><h2>Interactive pollution map</h2></div>
                <button className="map-fullscreen-button" type="button" onClick={mapFullscreen || mapFallbackExpanded ? closeMapFullscreen : openMapFullscreen}>{mapFullscreen || mapFallbackExpanded ? 'Exit full screen' : 'Expand map ⛶'}</button>
              </div>
              {mapDisplayCenter ? (
                <div className="map-canvas-shell">
                  <MapCanvas
                    center={[mapDisplayCenter.latitude, mapDisplayCenter.longitude]}
                    stations={areaStations}
                    routes={tripRoutes}
                    selectedRoute={selectedRoute}
                    origin={tripStart}
                    destination={tripEnd}
                  />
                </div>
              ) : (
                <div className="map-placeholder">
                  <div className="map-grid-lines" />
                  <div className="map-orbit orbit-one" /><div className="map-orbit orbit-two" />
                  <span className="map-pin">⌖</span>
                  <div className="map-caption"><span className="map-caption-dot" /> Set a location above to show it on the map</div>
                </div>
              )}
              <div className="map-legend">
                {airStationCoordinates ? <span><i className="legend-dot green" /> Nearest station: {airStation}{airStationDistance !== null ? ` · ${airStationDistance} km away` : ''}</span> : <span>Marker shows your selected location</span>}
                <span className="map-links"><a href={fullMapUrl} target="_blank" rel="noreferrer">Open full map ↗</a><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></span>
              </div>
              <div className="trip-planner">
                <div className="trip-planner-heading"><div><p className="eyebrow">POLLUTION-AWARE ROUTE PLANNER</p><h3>Trip A to Trip B</h3></div></div>
                <form className="trip-form" onSubmit={planTrip}>
                  <label><span>Trip A</span><input value={tripFrom} onChange={(event) => setTripFrom(event.target.value)} placeholder="e.g. Pune Junction railway station, Pune" /></label>
                  <span className="trip-arrow" aria-hidden="true">→</span>
                  <label><span>Trip B</span><input value={tripTo} onChange={(event) => setTripTo(event.target.value)} placeholder="e.g. SPPU or Dapodi, Pune" /></label>
                  <button className="button button-dark" type="submit" disabled={tripLoading}>{tripLoading ? 'Finding routes…' : 'Find routes'}</button>
                </form>
                {tripMessage && <p className="trip-message" role="status">{tripMessage}</p>}
                {tripRoutes.length > 0 && tripStart && tripEnd && <p className="trip-place-summary"><strong>Trip A:</strong> {tripStart.label} <span>→</span> <strong>Trip B:</strong> {tripEnd.label}</p>}
                {tripRoutes.length > 0 && <div className="route-card-list">
                  {displayedTripRoutes.map((route) => {
                    const airSummary = routeAirSummary.find((item) => item.route_index === route.id)
                    const isCleaner = comparableRoutes.length >= 2 && recommendedRouteId === route.id
                    const isFastest = fastestRouteId === route.id
                    return <article className={`route-card${selectedRoute === route.id ? ' selected' : ''}`} key={route.id}>
                      <div className="route-card-top"><strong>Route option {route.id + 1}</strong><span className="route-badges">{isCleaner && <i className="route-badge cleaner">Lower measured PM2.5</i>}{isFastest && <i className="route-badge">Fastest</i>}</span></div>
                      <p>{(route.distance / 1000).toFixed(1)} km · {Math.floor(route.duration / 3600) > 0 ? `${Math.floor(route.duration / 3600)} hr ` : ''}{Math.max(1, Math.round((route.duration % 3600) / 60))} min estimated</p>
                      <small>{airSummary?.measured_count ? `Mean nearby PM2.5: ${airSummary.mean_pm25?.toFixed(1)} µg/m³ (${airSummary.measured_count}/${airSummary.sample_count} route samples)` : 'No nearby PM2.5 station readings for this route'}</small>
                      <button className="station-view" type="button" onClick={() => setSelectedRoute(route.id)}>{selectedRoute === route.id ? 'Shown on map' : 'Show this route on map'}</button>
                    </article>
                  })}
                </div>}
                <p className="route-disclaimer">Air readings are sparse samples from nearby monitoring stations, not measurements of the whole road. A lower reading is not a guarantee of cleaner air. Driving routes powered by OSRM and OpenStreetMap.</p>
              </div>
              <p className="area-heading">Nearby readings around {location}</p>
              <div className="area-controls">
                <label htmlFor="area-radius">Search radius</label>
                <select id="area-radius" value={areaRadius} onChange={(event) => setAreaRadius(event.target.value)}>
                  <option value="5000">5 km</option><option value="10000">10 km</option><option value="25000">25 km</option>
                </select>
                <button className="button button-dark" type="button" onClick={loadAreaStations} disabled={areaLoading}>{areaLoading ? 'Searching…' : 'Load area pollution'}</button>
              </div>
              {areaMessage && <p className="area-message" role="status">{areaMessage}</p>}
              {areaStations.length > 0 && <div className="station-list" aria-label="Nearby monitoring stations">
                {areaStations.map((station) => {
                  const pm25 = station.readings.find((reading) => reading.parameter === 'pm25')
                  const pm10 = station.readings.find((reading) => reading.parameter === 'pm10')
                  const primary = pm25 || pm10
                  return <div className="station-row" key={`${station.station}-${station.latitude}`}>
                    <div><strong>{station.station}</strong><small>{station.distance_km} km away · {primary ? `${primary.parameter.toUpperCase()} ${primary.value.toFixed(1)} ${primary.units || ''}` : 'No PM2.5/PM10 value'}</small></div>
                    <button className="station-view" type="button" onClick={() => setMapCenter({ latitude: station.latitude, longitude: station.longitude })}>Show on map</button>
                  </div>
                })}
              </div>}
            </article>
          </section>

          <section className="panel trend-panel" id="trends" aria-label="Pollution trend">
            <div className="panel-heading"><div><p className="eyebrow">RECENT HISTORY</p><h2>PM2.5 trend · 7 days</h2></div><span className="panel-chip">{trendPoints.length ? `${trendPoints.length} saved samples` : 'Collecting samples'}</span></div>
            <div className="trend-chart-wrap">
              {trendPoints.length > 0 ? <svg className="trend-chart" viewBox="0 0 640 180" role="img" aria-label={`PM2.5 trend with ${trendPoints.length} saved readings`}>
                {[38, 94, 150].map((y) => <line key={y} x1="24" x2="616" y1={y} y2={y} className="chart-grid-line" />)}
                {trendPoints.length > 1 && <polyline points={trendChart} className="chart-line" />}
                {trendPoints.map((point, index) => {
                  const x = trendPoints.length === 1 ? 320 : 24 + (index / (trendPoints.length - 1)) * 592
                  const values = trendPoints.map((item) => item.value)
                  const min = Math.min(...values)
                  const spread = Math.max(...values) - min || 1
                  const y = trendPoints.length === 1 ? 94 : 150 - ((point.value - min) / spread) * 112
                  return <circle key={`${point.time}-${index}`} cx={x} cy={y} r="3.5" className="chart-point"><title>{`${new Date(point.time).toLocaleString()}: ${point.value.toFixed(1)} µg/m³`}</title></circle>
                })}
              </svg> : <div className="trend-empty">Load nearby air readings to begin collecting PM2.5 history.</div>}
            </div>
            <div className="chart-footnote">{trendPoints.length === 1 ? `Latest saved sample: ${trendPoints[0].value.toFixed(1)} µg/m³. Load readings again later to build the trend.` : 'History comes from samples saved to InfluxDB each time readings are loaded.'}</div>
          </section>

          <section className="integration-banner" aria-label="Environmental data connections">
            <div className="integration-symbol">↗</div>
            <div className="integration-content"><strong>Environmental data connections</strong><p>{airReadings.length && weather ? 'Live air and weather readings loaded and saved to InfluxDB.' : 'Services are checked below. Choose a city, then load air and weather data to save a local snapshot.'}</p>
              <div className="connection-list">
                <span className={`connection-status ${apiState}`}><i /> App API · {apiState === 'online' ? 'connected' : apiState === 'offline' ? 'offline' : 'checking'}</span>
                <span className={`connection-status ${influxState}`}><i /> InfluxDB · {influxState === 'online' ? 'connected' : influxState === 'offline' ? 'offline' : 'checking'}</span>
                <span className={`connection-status ${openaqConfigured ? 'online' : openaqConfigured === false ? 'offline' : 'checking'}`}><i /> OpenAQ · {airReadings.length ? 'data loaded' : openaqConfigured ? 'key saved' : openaqConfigured === false ? 'key missing' : 'checking'}</span>
                <span className={`connection-status ${weather ? 'online' : weatherConfigured ? 'checking' : weatherConfigured === false ? 'offline' : 'checking'}`}><i /> Weather · {weather ? 'data loaded' : weatherConfigured ? 'key saved; awaiting provider' : weatherConfigured === false ? 'key missing' : 'checking'}</span>
              </div>
            </div>
            <span className="integration-tag">{apiState === 'offline' || influxState === 'offline' ? 'CHECK CONNECTION' : airReadings.length && weather ? 'DATA LOADED' : 'READY TO COLLECT'}</span>
          </section>
          <footer className="page-footer"><span>INFOY ENVIRONMENTAL DASHBOARD</span><span>Local development preview · OpenAQ and InfluxDB data stored when loaded</span></footer>
        </div>
      </main>
    </div>
  )
}

export default App


