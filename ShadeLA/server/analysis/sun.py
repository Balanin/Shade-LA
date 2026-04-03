from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
import math
from typing import Iterable

try:
    from ladybug.location import Location
    from ladybug.sunpath import Sunpath
except ImportError:  # pragma: no cover
    Location = None
    Sunpath = None


@dataclass
class SunVector:
    direction: tuple[float, float, float]
    timestamp: datetime


def _datetime_range(
    start_date: date,
    end_date: date,
    start_hour: float,
    end_hour: float,
    timestep_hours: float,
) -> Iterable[datetime]:
    current_day = start_date
    while current_day <= end_date:
        current_hour = start_hour
        while current_hour <= end_hour + 1e-9:
            hour = int(current_hour)
            minute = int(round((current_hour - hour) * 60))
            yield datetime.combine(current_day, time(hour=hour, minute=minute))
            current_hour += timestep_hours
        current_day += timedelta(days=1)


def _manual_solar_position(latitude: float, longitude: float, moment: datetime) -> tuple[float, float]:
    day_of_year = moment.timetuple().tm_yday
    fractional_hour = moment.hour + moment.minute / 60.0
    declination = math.radians(23.45 * math.sin(math.radians((360 / 365) * (284 + day_of_year))))
    hour_angle = math.radians(15 * (fractional_hour - 12))
    latitude_rad = math.radians(latitude)

    altitude = math.asin(
        math.sin(latitude_rad) * math.sin(declination)
        + math.cos(latitude_rad) * math.cos(declination) * math.cos(hour_angle)
    )

    azimuth = math.atan2(
        math.sin(hour_angle),
        math.cos(hour_angle) * math.sin(latitude_rad) - math.tan(declination) * math.cos(latitude_rad),
    )

    azimuth_from_north = (math.degrees(azimuth) + 180.0) % 360.0
    return math.degrees(altitude), azimuth_from_north


def generate_sun_vectors(
    latitude: float,
    longitude: float,
    start_date: date,
    end_date: date,
    start_hour: float,
    end_hour: float,
    timestep_hours: float,
    north_angle_degrees: float,
) -> list[SunVector]:
    location = None
    sunpath = None

    if Location is not None and Sunpath is not None:
        location = Location(latitude=latitude, longitude=longitude)
        sunpath = Sunpath.from_location(location)

    sun_vectors: list[SunVector] = []

    for moment in _datetime_range(start_date, end_date, start_hour, end_hour, timestep_hours):
        if sunpath is not None:
            sun = sunpath.calculate_sun(month=moment.month, day=moment.day, hour=moment.hour + moment.minute / 60.0)
            altitude = sun.altitude
            azimuth = sun.azimuth
        else:
            altitude, azimuth = _manual_solar_position(latitude, longitude, moment)

        if altitude <= 0:
            continue

        altitude_rad = math.radians(altitude)
        azimuth_rad = math.radians(azimuth + north_angle_degrees)
        horizontal = math.cos(altitude_rad)

        direction = (
            math.sin(azimuth_rad) * horizontal,
            math.sin(altitude_rad),
            -math.cos(azimuth_rad) * horizontal,
        )
        sun_vectors.append(SunVector(direction=direction, timestamp=moment))

    return sun_vectors
