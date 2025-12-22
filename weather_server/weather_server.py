import ssl
import time
import threading
import json
import socketserver
import requests
from http.server import BaseHTTPRequestHandler, HTTPServer
from http import HTTPStatus
from socketserver import ThreadingMixIn

# --- Configuration ---
HOST = "0.0.0.0"
PORT = 443
CERTFILE = "/tmp/cert.pem"
KEYFILE = "/tmp/key.pem"
LAT = None
LON = None
weather_data = None
location_data = None
# ---------------------

def transform_weather_data(source_json):
    """
    Transforms NWS-style weather observation JSON into a custom target format.
    Args:
        source_json (dict): The input dictionary in the NWS GeoJSON/LD format.
    Returns:
        dict: The transformed dictionary in the custom target format.
    """
    properties = source_json.get('properties', {})
    geometry = source_json.get('geometry', {})
    
    def get_value(key):
        return properties.get(key, {}).get('value')
        
    # 1. Location Data
    # StationName is used as the primary city/name, although this is sometimes a specific airport
    station_name = properties.get('stationName', 'Unknown Location')
    
    # Coordinate extraction: [longitude, latitude]
    coordinates = geometry.get('coordinates', [None, None])
    longitude = str(coordinates[0]) if coordinates[0] is not None else "0.0"
    latitude = str(coordinates[1]) if coordinates[1] is not None else "0.0"
    
    # 2. Weather Data
    # Temperature: value is in degC, convert to float
    temperature_c = get_value('temperature')
    temperature = float(temperature_c) if temperature_c is not None else 0.0
    
    # Relative Humidity: value is in percent
    relative_humidity = get_value('relativeHumidity')
    humidity = int(round(relative_humidity)) if relative_humidity is not None else 0
    
    # Wind Speed: value is in km/h, convert to float
    wind_speed_kmh = get_value('windSpeed')
    wind_speed = float(wind_speed_kmh) if wind_speed_kmh is not None else 0.0
    
    # Wind Direction: value is in degrees, convert to a basic cardinal direction
    wind_direction_deg = get_value('windDirection')
    wind_dir_text = "N/A"
    if wind_direction_deg is not None:
        # Simple cardinal direction logic (e.g., 0-22.5 is N, 22.5-67.5 is NE, etc.)
        dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        index = int((wind_direction_deg % 360) / 22.5)
        wind_dir_text = dirs[index]

    
    text_description = properties.get('textDescription', 'Unknown').lower()
    skycon_map = {
            "clear": "CLEAR_DAY", "sunny": "CLEAR_DAY", "partly cloudy": "PARTLY_CLOUDY_DAY",
        "cloudy": "CLOUDY", "overcast": "CLOUDY", "rain": "RAIN",
        "snow": "SNOW", "fog": "FOG"
    }
    def map_description(text_description,skycon_map):
        for k in skycon_map.keys():
            if k in text_description:
                return skycon_map[k]
        return skycon_map["clear"]
    skycon = map_description(text_description,skycon_map)
    
    pub_time = int(time.time())
    # Placeholder for the arbitrary city ID
    city_id_placeholder = "n000000"
    
    transformed_data = {
        "city": {
            "city": station_name,
            "cityId": city_id_placeholder,
            "cnAddress": {
                "city": "", 
                "cityId": city_id_placeholder,
                "country": "",
                "province": ""
            },
            "cnCity": "",
            "country": "", # Assumption based on weather.gov data
            "enAddress": {
                "city": station_name,
                "cityId": city_id_placeholder,
                "country": "",
                "province": "" # Province/State is not directly mapped here
            },
            "latitude": latitude,
            "longitude": longitude,
            "name": station_name,
            "name_cn": "",
            "name_cn_tw": "",
            "name_en": station_name,
            "province": "",
            # Placeholder: Timezone information is not provided in source.
            "timezone": "America/New_York", 
            "timezoneFmt": "UTC-5" 
        },
        "city_id": city_id_placeholder,
        "weather": {
            # --- AQI/Pollution (Placeholders, as this is NOT in the source data) ---
            "aqi": 0,
            "aqi_day_max_cn": 0,
            "aqi_day_max_en": 0,
            "aqi_day_min_cn": 0,
            "aqi_day_min_en": 0,
            "aqi_us": 0,
            "co": 0.0,
            "co_us": 0.0,
            "no2": 0,
            "no2_us": 0,
            "noAqi": True, # Indicates no AQI data
            "o3": 0,
            "o3_us": 0.0,
            "pm10": 0,
            "pm25": 0,
            "so2": 0,
            "so2_us": 0,
            
            # --- Available Weather Data ---
            "humidity": humidity,
            "probability": 0, # NWS observation doesn't directly provide rain probability
            "pub_time": pub_time,
            "skycon": skycon,
            
            # --- Temperature (Temp max/min must be placeholders) ---
            "temp_max": temperature, # Using current temp as a simple placeholder for the day's max
            "temp_min": temperature, # Using current temp as a simple placeholder for the day's min
            "temperature": temperature,
            
            "ultraviolet": 0, # Placeholder, UV index not in source data
            "vehicle_limit": {
                "type": "city_unlimited" # Placeholder/default value
            },
            
            # --- Wind Data ---
            "wind": {
                "speed": round(wind_speed, 2), # km/h
                "wind_dir": wind_dir_text,
                "wind_level": int(wind_speed / 5), # Crude wind level based on speed
            }
        }
    }
    # {"city_id":"n980610","name":"Test","name_cn":"\u6ce2\u7279\u5170","name_en":"Test1","name_cn_tw":"\u6ce2\u7279\u5170","country":"U.S.A.","country_cn":"U.S.A.","country_en":"U.S.A.","country_cn_tw":"U.S.A.","area_cn_first":"","area_cn_second":"<h1>Moonbase 1</h1><script>alert(1);</alert>","area_first":"","timezone":"America/Los_Angeles","timezone_gmt":"GMT-7:00","coordinate":{"longitude":"-122.67621","latitude":"45.52345"}
    location_data = {"city_id": city_id_placeholder , "name": station_name, "name_cn" : "", "name_en": station_name, "country":"" } 
    return json.dumps(transformed_data),json.dumps(location_data)

USER_AGENT = 'airqmonitor/1.0 (https://github.com/ea)'

def get_nearest_station_id(latitude, longitude):
    points_url = f"https://api.weather.gov/points/{latitude},{longitude}"    
    headers = {'User-Agent': USER_AGENT}
    
    try:
        response = requests.get(points_url, headers=headers)
        response.raise_for_status() 
        data = response.json()        
        stations_url = data.get('properties', {}).get('observationStations')        
        if not stations_url:
            print("Error: Could not find the 'observationStations' URL.")
            return None            
        print(f"2. Fetching station list from: {stations_url}")
        station_response = requests.get(stations_url, headers=headers)
        station_response.raise_for_status()
        station_data = station_response.json()
        
        # The nearest station is typically the first entry in the 'features' array
        features = station_data.get('features', [])
        if features:
            # The station ID is inside properties.stationIdentifier
            station_id = features[0]['properties']['stationIdentifier']
            print(f"   -> Found nearest station ID: {station_id}")
            return station_id
        else:
            print("Error: No observation stations found near this location.")
            return None
            
    except requests.exceptions.RequestException as e:
        print(f"Error during API call: {e}")
        return None


def get_current_observation(station_id):
    if not station_id:
        return None
    observation_url = f"https://api.weather.gov/stations/{station_id}/observations/latest"
    headers = {'User-Agent': USER_AGENT}
    try:
        response = requests.get(observation_url, headers=headers)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        return None

def scheduled_weather_update():
	# 1. fetch data from NWS
	# 2. transform data to suitable json
	# 3. sleep 10 minutes
    global weather_data,location_data
    station_id = get_nearest_station_id(LAT, LON)
    if station_id:
        current_data = get_current_observation(station_id)
        weather_data,location_data = transform_weather_data(current_data)
        print(location_data)
    t = threading.Timer(600, scheduled_weather_update)
    t.daemon = True
    t.start()

        

class ThreadingTLSServer(ThreadingMixIn, HTTPServer):
    pass


class HttpsRequestHandler(BaseHTTPRequestHandler):
    """
    A custom handler to process HTTP requests.
    """

    def _set_headers(self, status_code=200, content_type='application/json'):
        """Helper function to set common response headers."""
        self.send_response(status_code)
        self.send_header('Content-type', content_type)
        self.end_headers()
    def _send_json(self,payload):
        body = payload.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        """Handle GET requests."""
        global weather_data,location_data
        if self.path == '/daily/locate':
            payload = '{"data":'+location_data + ',"code":0}'
            self._send_json(payload)
            return
        elif self.path.startswith("/daily/weatherNow"):
            payload = '{"code" : 0,"data" : ' + weather_data + '}'
            print(payload)
            self._send_json(payload)
            return
        elif self.path.startswith("/device/pairStatus"):
            payload = """
            {"desc":"ok","code":10503}
            """
            self._send_json(payload)
            return
        elif self.path.startswith("/cooperation/companies?lang=en_US"):
            payload = """
            {"data":{"cooperation":["private"]},"code":1}
            """
            self._send_json(payload)
            return
        elif self.path.startswith("/firmware/checkUpdate"):
            payload = """{"data":{"upgrade_sign": 0 } , "code" : 0 }"""
            return

        else:
            # --- Handle other paths (404 Not Found) ---
            self._set_headers(404)
            error_message = json.dumps({"error": "Not Found", "path": self.path})
            self.wfile.write(error_message.encode('utf-8'))
            print(f"[{self.client_address[0]}:{self.client_address[1]}] 404 Not Found for {self.path}")


def run_server():

    server_address = (HOST, PORT)
    scheduled_weather_update()
    httpd = ThreadingTLSServer(server_address, HttpsRequestHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    import os
    os.system('ls /tmp')
    try:
        context.load_cert_chain(certfile=CERTFILE, keyfile=KEYFILE)
    except FileNotFoundError:
        print(f"ERROR: Certificate file(s) not found.")
        return
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    print("Press Ctrl+C to stop.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

    httpd.server_close()
    print("Server stopped.")


if __name__ == '__main__':
    run_server()
