import csv
import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


_photon_lock = threading.Lock()
_photon_last_request = 0.0


def photon_search(endpoint: str) -> dict:
    """Keep public Photon requests gentle while resolving user-entered places."""
    global _photon_last_request
    with _photon_lock:
        wait_seconds = 1.0 - (time.monotonic() - _photon_last_request)
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        _photon_last_request = time.monotonic()
        request = Request(endpoint, headers={"Accept": "application/json", "User-Agent": "AirSenseEnvironmentalDashboard/1.0"}, method="GET")
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))


def load_local_env() -> None:
    """Load simple KEY=value settings without printing private values."""
    env_file = Path(__file__).with_name(".env")
    if not env_file.is_file():
        return

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        # A blank shell variable should not hide a usable value from .env.
        if value and not os.environ.get(key, "").strip():
            os.environ[key] = value


load_local_env()

app = FastAPI(title="AirSense Environmental API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def influx_settings() -> tuple[str, str, str, str]:
    url = os.getenv("INFLUX_URL", "http://localhost:8086").rstrip("/")
    org = os.getenv("INFLUX_ORG", "")
    bucket = os.getenv("INFLUX_BUCKET", "")
    token = os.getenv("INFLUX_TOKEN", "")
    if not org or not bucket or not token:
        raise HTTPException(
            status_code=503,
            detail="InfluxDB settings are incomplete. Check backend/.env.",
        )
    return url, org, bucket, token


def run_flux_query(flux: str) -> str:
    url, org, _bucket, token = influx_settings()
    endpoint = f"{url}/api/v2/query?{urlencode({'org': org})}"
    request = Request(
        endpoint,
        data=flux.encode("utf-8"),
        headers={
            "Authorization": f"Token {token}",
            "Content-Type": "application/vnd.flux",
            "Accept": "application/csv",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=8) as response:
            return response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        # Keep credentials and provider response details out of API errors.
        raise HTTPException(
            status_code=503,
            detail="Could not connect to InfluxDB. Check that Docker is running and the local settings are correct.",
        ) from exc


def write_influx_point(
    measurement: str,
    field: str,
    value: float,
    location: str,
    timestamp: datetime | None = None,
) -> None:
    url, org, bucket, token = influx_settings()
    point = (
        f"{escape_tag(measurement)},location={escape_tag(location)} "
        f"{escape_tag(field)}={value!r}"
    )
    if timestamp is not None:
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        point += f" {int(timestamp.timestamp() * 1_000_000_000)}"

    endpoint = f"{url}/api/v2/write?{urlencode({'org': org, 'bucket': bucket, 'precision': 'ns'})}"
    request = Request(
        endpoint,
        data=point.encode("utf-8"),
        headers={"Authorization": f"Token {token}", "Content-Type": "text/plain; charset=utf-8"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=8):
            pass
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not write to InfluxDB. Check that Docker is running and the local settings are correct.",
        ) from exc


def openaq_get(path: str, params: dict[str, str]) -> dict:
    api_key = os.getenv("OPENAQ_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAQ is not configured. Add its key to backend/.env and restart the backend.")
    endpoint = f"https://api.openaq.org/v3/{path}?{urlencode(params)}"
    request = Request(
        endpoint,
        headers={"X-API-Key": api_key, "Accept": "application/json"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        message = "OpenAQ rejected the request. Check that the API key is valid and the account is verified."
        if exc.code == 429:
            message = "OpenAQ request limit reached. Wait a moment and try again."
        raise HTTPException(status_code=502, detail=message) from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="Could not reach OpenAQ. Check your internet connection and try again.") from exc


@app.get("/api/geocode")
def geocode_location(name: str = Query(min_length=2, max_length=120)):
    search_name = name.strip()
    normalized = re.sub(r"\s+", " ", search_name.lower()).strip()
    specific_place = any(word in normalized for word in ("station", "university", "college", "hospital", "airport", "sppu", "dapodi", "mall"))
    photon_query = search_name
    if "sppu" in normalized:
        photon_query = "Savitribai Phule Pune University, Pune, Maharashtra, India"
    elif "pune" in normalized and "railway station" in normalized:
        photon_query = "Pune Junction railway station, Pune, Maharashtra, India"
    elif "dapodi" in normalized and "pune" not in normalized:
        photon_query = "Dapodi, Pune, Maharashtra, India"

    photon_params = {"q": photon_query, "limit": "8", "lang": "en"}
    if "pune" in normalized or "sppu" in normalized or "dapodi" in normalized:
        photon_params.update({"lat": "18.5204", "lon": "73.8567", "zoom": "12", "location_bias_scale": "0.2"})
    try:
        photon_payload = photon_search("https://photon.komoot.io/api/?" + urlencode(photon_params))
        features = photon_payload.get("features", [])
        photon_results = []
        for feature in features:
            properties = feature.get("properties") or {}
            point = feature.get("geometry", {}).get("coordinates") or []
            if len(point) < 2:
                continue
            if ("pune" in normalized or "sppu" in normalized or "dapodi" in normalized) and properties.get("countrycode", "").lower() not in {"in", ""}:
                continue
            place_name = properties.get("name") or properties.get("street") or properties.get("city")
            if not place_name:
                continue
            photon_results.append({
                "name": place_name,
                "admin1": properties.get("city") or properties.get("district") or properties.get("state"),
                "country": properties.get("country"),
                "latitude": point[1],
                "longitude": point[0],
                "place_type": " ".join(str(value) for value in (properties.get("osm_key"), properties.get("osm_value")) if value),
            })
        if photon_results:
            return {"results": photon_results, "source": "OpenStreetMap Photon"}
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
        pass

    # Don't silently turn a missing landmark into a city-center route.
    if specific_place:
        return {"results": [], "source": "OpenStreetMap Photon", "message": "That landmark was not found. Try its full name and city, such as “Pune Junction railway station, Pune”."}

    endpoint = "https://geocoding-api.open-meteo.com/v1/search?" + urlencode(
        {"name": search_name, "count": "5", "language": "en", "format": "json"}
    )
    request = Request(endpoint, headers={"Accept": "application/json"}, method="GET")
    try:
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="Could not look up that place. Check your internet connection and try again.") from exc

    places = payload.get("results", [])
    return {
        "source": "Open-Meteo",
        "results": [
            {
                "name": place.get("name"),
                "admin1": place.get("admin1"),
                "country": place.get("country"),
                "latitude": place.get("latitude"),
                "longitude": place.get("longitude"),
            }
            for place in places
        ]
    }


@app.get("/api/routes")
def get_driving_routes(
    from_latitude: float = Query(ge=-90, le=90),
    from_longitude: float = Query(ge=-180, le=180),
    to_latitude: float = Query(ge=-90, le=90),
    to_longitude: float = Query(ge=-180, le=180),
):
    coordinates = f"{from_longitude},{from_latitude};{to_longitude},{to_latitude}"
    endpoint = f"https://router.project-osrm.org/route/v1/driving/{coordinates}?{urlencode({'alternatives': '2', 'overview': 'full', 'geometries': 'geojson'})}"
    request = Request(endpoint, headers={"Accept": "application/json", "User-Agent": "AirSenseEnvironmentalDashboard/1.0"}, method="GET")
    try:
        with urlopen(request, timeout=25) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise HTTPException(status_code=502, detail="The route service could not find a route. Try nearby landmarks or a full city name.") from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="Could not reach the route service. Check your internet connection and try again.") from exc
    if payload.get("code") != "Ok" or not payload.get("routes"):
        raise HTTPException(status_code=404, detail="No driving route was found between those places.")
    return {"routes": payload["routes"], "waypoints": payload.get("waypoints", [])}


@app.get("/api/weather")
def get_current_weather(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
):
    api_key = os.getenv("OPENWEATHER_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="Weather is not configured. Add OPENWEATHER_API_KEY to backend/.env and restart the backend.")

    endpoint = "https://api.openweathermap.org/data/2.5/weather?" + urlencode(
        {"lat": latitude, "lon": longitude, "units": "metric", "appid": api_key}
    )
    request = Request(endpoint, headers={"Accept": "application/json"}, method="GET")
    try:
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        message = "OpenWeatherMap rejected the request. Check that the API key is correct and active."
        if exc.code == 429:
            message = "OpenWeatherMap request limit reached. Wait a moment and try again."
        raise HTTPException(status_code=502, detail=message) from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="Could not reach OpenWeatherMap. Check your internet connection and try again.") from exc

    main = payload.get("main") or {}
    weather_item = (payload.get("weather") or [{}])[0]
    wind = payload.get("wind") or {}
    location_name = payload.get("name") or "Selected location"
    country = (payload.get("sys") or {}).get("country")
    location_label = f"{location_name}, {country}" if country else location_name
    observed_at = datetime.fromtimestamp(payload.get("dt", datetime.now(timezone.utc).timestamp()), tz=timezone.utc)
    stored = 0
    for field, value in (
        ("temperature_c", main.get("temp")),
        ("humidity_pct", main.get("humidity")),
        ("wind_speed_m_s", wind.get("speed")),
    ):
        if value is None:
            continue
        write_influx_point("weather", field, float(value), location_label, observed_at)
        stored += 1

    return {
        "source": "OpenWeatherMap",
        "location": location_label,
        "temperature_c": main.get("temp"),
        "description": weather_item.get("description"),
        "humidity_pct": main.get("humidity"),
        "wind_speed_m_s": wind.get("speed"),
        "observed_at": observed_at.isoformat(),
        "stored": stored,
    }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_km = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    term = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    return 2 * radius_km * math.asin(math.sqrt(term))


def parse_influx_csv(content: str) -> list[dict[str, str]]:
    rows = csv.reader(StringIO(content))
    header: list[str] | None = None
    readings: list[dict[str, str]] = []
    for row in rows:
        if not row or (row[0].startswith("#")):
            continue
        if header is None:
            header = row
            continue
        if row == header:
            continue
        if len(row) < len(header):
            row.extend([""] * (len(header) - len(row)))
        readings.append(dict(zip(header, row)))
    return readings


@app.get("/health")
def health_check():
    return {"status": "ok", "service": "airsense-api"}


@app.get("/health/influxdb")
def influx_health_check():
    _url, _org, bucket, _token = influx_settings()
    flux = f"from(bucket: {json.dumps(bucket)}) |> range(start: -1h) |> limit(n: 1)"
    run_flux_query(flux)
    return {"status": "ok", "service": "influxdb", "bucket": bucket}


@app.get("/health/connections")
def connection_status():
    """Expose configuration state only; never return API keys or tokens."""
    return {
        "openaq_configured": bool(os.getenv("OPENAQ_API_KEY", "").strip()),
        "weather_configured": bool(os.getenv("OPENWEATHER_API_KEY", "").strip()),
    }


@app.get("/api/readings")
def get_readings(
    start: str = Query(default="-24h", pattern=r"^-[0-9]+[smhdw]$"),
    location: str | None = Query(default=None, max_length=120),
):
    _url, _org, bucket, _token = influx_settings()
    filters = ""
    if location:
        filters = f" |> filter(fn: (r) => r.location == {json.dumps(location)})"
    flux = (
        f"from(bucket: {json.dumps(bucket)})"
        f" |> range(start: {start}){filters}"
        " |> sort(columns: [\"_time\"], desc: true)"
        " |> limit(n: 500)"
    )
    readings = parse_influx_csv(run_flux_query(flux))
    return {"source": "influxdb", "bucket": bucket, "count": len(readings), "readings": readings}


class ReadingInput(BaseModel):
    measurement: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    field: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    value: float
    location: str = Field(min_length=1, max_length=120)
    timestamp: datetime | None = None


class RouteSample(BaseModel):
    route_index: int = Field(ge=0, le=2)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class RouteAirRequest(BaseModel):
    samples: list[RouteSample] = Field(min_length=1, max_length=12)


def escape_tag(value: str) -> str:
    return value.replace("\\", "\\\\").replace(",", "\\,").replace("=", "\\=").replace(" ", "\\ ")


@app.post("/api/readings", status_code=201)
def write_reading(reading: ReadingInput):
    if not math.isfinite(reading.value):
        raise HTTPException(status_code=422, detail="Reading value must be a finite number.")

    write_influx_point(reading.measurement, reading.field, reading.value, reading.location, reading.timestamp)
    return {"status": "stored", "measurement": reading.measurement, "location": reading.location}


@app.get("/api/openaq/nearby")
def get_nearby_air_quality(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
    radius: int = Query(default=25000, ge=1000, le=25000),
):
    locations_response = openaq_get(
        "locations",
        {"coordinates": f"{latitude:.4f},{longitude:.4f}", "radius": str(radius), "limit": "100", "page": "1"},
    )
    locations = locations_response.get("results", [])
    candidates = []
    for item in locations:
        coordinates = item.get("coordinates") or {}
        station_lat = coordinates.get("latitude")
        station_lon = coordinates.get("longitude")
        if station_lat is None or station_lon is None:
            continue
        candidates.append((haversine_km(latitude, longitude, station_lat, station_lon), item))
    if not candidates:
        return {"source": "OpenAQ", "station": None, "readings": [], "stored": 0, "message": "No monitoring stations were found within this radius."}

    distance_km, station = min(candidates, key=lambda pair: pair[0])
    sensors = station.get("sensors") or []
    if not sensors:
        sensors_response = openaq_get(f"locations/{station['id']}/sensors", {"limit": "100", "page": "1"})
        sensors = sensors_response.get("results", [])
    sensor_by_id = {sensor.get("id"): sensor for sensor in sensors}

    latest_response = openaq_get(f"locations/{station['id']}/latest", {"limit": "100", "page": "1"})
    readings = []
    stored = 0
    station_label = station.get("name") or station.get("locality") or f"OpenAQ station {station['id']}"
    for item in latest_response.get("results", []):
        sensor = sensor_by_id.get(item.get("sensorsId"), {})
        parameter = sensor.get("parameter") or {}
        field = str(parameter.get("name") or "").lower()
        value = item.get("value")
        if not field or not re.fullmatch(r"[a-z0-9_-]+", field) or value is None:
            continue
        try:
            numeric_value = float(value)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(numeric_value):
            continue

        observed_at = None
        utc_time = (item.get("datetime") or {}).get("utc")
        if utc_time:
            try:
                observed_at = datetime.fromisoformat(utc_time.replace("Z", "+00:00"))
            except ValueError:
                observed_at = None
        try:
            write_influx_point("air_quality", field, numeric_value, station_label, observed_at)
            stored += 1
        except HTTPException:
            raise

        readings.append({
            "parameter": field,
            "units": parameter.get("units"),
            "value": numeric_value,
            "datetime": utc_time,
            "station": station_label,
        })

    return {
        "source": "OpenAQ",
        "station": station_label,
        "station_coordinates": station.get("coordinates"),
        "distance_km": round(distance_km, 2),
        "readings": readings,
        "stored": stored,
        "message": None if readings else "The nearest station has no recent measurements available.",
    }


@app.get("/api/openaq/area")
def get_area_air_quality(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
    radius: int = Query(default=10000, ge=1000, le=25000),
):
    """Return latest readings from a handful of nearby stations for area comparison."""
    locations_response = openaq_get(
        "locations",
        {"coordinates": f"{latitude:.4f},{longitude:.4f}", "radius": str(radius), "limit": "100", "page": "1"},
    )
    candidates = []
    for station in locations_response.get("results", []):
        coordinates = station.get("coordinates") or {}
        station_lat = coordinates.get("latitude")
        station_lon = coordinates.get("longitude")
        if station_lat is None or station_lon is None:
            continue
        distance = haversine_km(latitude, longitude, station_lat, station_lon)
        candidates.append((distance, station))

    stations = []
    for distance, station in sorted(candidates, key=lambda item: item[0])[:5]:
        sensors = station.get("sensors") or []
        if not sensors:
            sensor_response = openaq_get(f"locations/{station['id']}/sensors", {"limit": "100", "page": "1"})
            sensors = sensor_response.get("results", [])
        sensor_by_id = {sensor.get("id"): sensor for sensor in sensors}
        latest_response = openaq_get(f"locations/{station['id']}/latest", {"limit": "100", "page": "1"})
        station_label = station.get("name") or station.get("locality") or f"OpenAQ station {station['id']}"
        readings = []
        for item in latest_response.get("results", []):
            sensor = sensor_by_id.get(item.get("sensorsId"), {})
            parameter = sensor.get("parameter") or {}
            field = str(parameter.get("name") or "").lower()
            value = item.get("value")
            if not field or not re.fullmatch(r"[a-z0-9_-]+", field) or value is None:
                continue
            try:
                numeric_value = float(value)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(numeric_value):
                continue
            utc_time = (item.get("datetime") or {}).get("utc")
            observed_at = None
            if utc_time:
                try:
                    observed_at = datetime.fromisoformat(utc_time.replace("Z", "+00:00"))
                except ValueError:
                    pass
            write_influx_point("air_quality", field, numeric_value, station_label, observed_at)
            readings.append({"parameter": field, "units": parameter.get("units"), "value": numeric_value, "datetime": utc_time})

        coordinates = station.get("coordinates") or {}
        stations.append({
            "station": station_label,
            "latitude": coordinates.get("latitude"),
            "longitude": coordinates.get("longitude"),
            "distance_km": round(distance, 2),
            "readings": readings,
        })

    return {"source": "OpenAQ", "radius_m": radius, "stations": stations, "count": len(stations)}


@app.post("/api/openaq/route-readings")
def get_route_air_quality(request: RouteAirRequest):
    """Sample nearby monitoring stations along candidate routes for a cautious comparison."""
    station_cache: dict[int, dict] = {}
    samples = []
    for sample in request.samples:
        locations_response = openaq_get(
            "locations",
            {"coordinates": f"{sample.latitude:.4f},{sample.longitude:.4f}", "radius": "5000", "limit": "30", "page": "1"},
        )
        candidates = []
        for station in locations_response.get("results", []):
            coordinates = station.get("coordinates") or {}
            station_lat = coordinates.get("latitude")
            station_lon = coordinates.get("longitude")
            if station_lat is not None and station_lon is not None:
                candidates.append((haversine_km(sample.latitude, sample.longitude, station_lat, station_lon), station))
        if not candidates:
            samples.append({"route_index": sample.route_index, "station": None, "distance_km": None, "pm25": None, "units": None})
            continue

        station_distance, station = min(candidates, key=lambda item: item[0])
        station_id = int(station["id"])
        if station_id not in station_cache:
            sensors = station.get("sensors") or []
            if not sensors:
                sensor_response = openaq_get(f"locations/{station_id}/sensors", {"limit": "100", "page": "1"})
                sensors = sensor_response.get("results", [])
            sensor_by_id = {sensor.get("id"): sensor for sensor in sensors}
            latest_response = openaq_get(f"locations/{station_id}/latest", {"limit": "100", "page": "1"})
            station_label = station.get("name") or station.get("locality") or f"OpenAQ station {station_id}"
            pm25 = None
            pm25_units = None
            readings = []
            for item in latest_response.get("results", []):
                sensor = sensor_by_id.get(item.get("sensorsId"), {})
                parameter = sensor.get("parameter") or {}
                field = str(parameter.get("name") or "").lower()
                value = item.get("value")
                if not field or value is None:
                    continue
                try:
                    numeric_value = float(value)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(numeric_value) or not re.fullmatch(r"[a-z0-9_-]+", field):
                    continue
                utc_time = (item.get("datetime") or {}).get("utc")
                observed_at = None
                if utc_time:
                    try:
                        observed_at = datetime.fromisoformat(utc_time.replace("Z", "+00:00"))
                    except ValueError:
                        pass
                write_influx_point("air_quality", field, numeric_value, station_label, observed_at)
                readings.append({"parameter": field, "value": numeric_value, "units": parameter.get("units")})
                if field == "pm25":
                    pm25 = numeric_value
                    pm25_units = parameter.get("units")
            station_coordinates = station.get("coordinates") or {}
            station_cache[station_id] = {
                "station": station_label,
                "latitude": station_coordinates.get("latitude"),
                "longitude": station_coordinates.get("longitude"),
                "pm25": pm25,
                "units": pm25_units,
                "readings": readings,
            }

        saved_station = station_cache[station_id]
        samples.append({
            "route_index": sample.route_index,
            "station": saved_station["station"],
            "latitude": saved_station["latitude"],
            "longitude": saved_station["longitude"],
            "distance_km": round(station_distance, 2),
            "pm25": saved_station["pm25"],
            "units": saved_station["units"],
        })

    summaries = []
    for route_index in sorted({sample.route_index for sample in request.samples}):
        route_samples = [sample for sample in samples if sample["route_index"] == route_index]
        values = [sample["pm25"] for sample in route_samples if sample["pm25"] is not None]
        summaries.append({
            "route_index": route_index,
            "sample_count": len(route_samples),
            "measured_count": len(values),
            "mean_pm25": round(sum(values) / len(values), 2) if values else None,
        })
    return {"source": "OpenAQ", "samples": samples, "routes": summaries}

