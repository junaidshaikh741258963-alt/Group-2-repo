export interface WeatherForecast {
  date: string;
  description: string;
  highC: number;
  lowC: number;
  precipitationMm: number;
  windSpeedKmh: number;
  weatherCode: number;
}

const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

export async function geocode(place: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place)}&limit=1`,
      { headers: { "User-Agent": "TripCraftAI/1.0" } }
    );
    const data = await res.json();
    if (data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch {
    // silent
  }
  return null;
}

export async function getWeatherForecast(
  lat: number,
  lng: number,
  startDate: string,
  endDate: string
): Promise<WeatherForecast[]> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,windspeed_10m_max&start_date=${startDate}&end_date=${endDate}&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const daily = data.daily;
    if (!daily) return [];

    const forecasts: WeatherForecast[] = [];
    const maxDays = Math.min(daily.time.length, 16);
    for (let i = 0; i < maxDays; i++) {
      forecasts.push({
        date: daily.time[i],
        description: WEATHER_CODES[daily.weathercode[i]] || `Code ${daily.weathercode[i]}`,
        highC: Math.round(daily.temperature_2m_max[i]),
        lowC: Math.round(daily.temperature_2m_min[i]),
        precipitationMm: daily.precipitation_sum[i],
        windSpeedKmh: Math.round(daily.windspeed_10m_max[i]),
        weatherCode: daily.weathercode[i],
      });
    }
    return forecasts;
  } catch {
    return [];
  }
}

export function formatWeatherForAgent(forecasts: WeatherForecast[]): string {
  if (forecasts.length === 0) return "Weather data unavailable.";
  return forecasts
    .map(
      (f) =>
        `${f.date}: ${f.description}, High ${f.highC}°C / Low ${f.lowC}°C, Precip ${f.precipitationMm}mm, Wind ${f.windSpeedKmh}km/h`
    )
    .join("\n");
}

export function isGoodWeatherDay(forecast: WeatherForecast): boolean {
  return forecast.weatherCode <= 3 && forecast.precipitationMm < 2;
}
