#!/usr/bin/env python3
"""
Emisor mínimo MAVLink v2 (dialecto común) para probar el ingestor corenexus.
Requiere: pymavlink (CoreNexus/requirements-mavlink.txt).
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time


def main() -> int:
    os.environ.setdefault("MAVLINK20", "1")

    p = argparse.ArgumentParser(description="Emisor MAVLink de prueba (HEARTBEAT, ATTITUDE, GLOBAL_POSITION_INT).")
    p.add_argument("--mode", choices=("udp", "serial"), required=True)
    p.add_argument(
        "--udp",
        default="127.0.0.1:14550",
        help="Destino udpout (host:puerto); debe coincidir con --mavlink-udp de corenexus.",
    )
    p.add_argument("--serial", help="Dispositivo serie (solo --mode serial).")
    p.add_argument("--baud", type=int, default=57600)
    p.add_argument("--sys", type=int, default=1, dest="sysid")
    p.add_argument("--comp", type=int, default=200, dest="compid")
    p.add_argument("--hz", type=float, default=5.0, help="Mensajes por segundo (aprox.).")
    p.add_argument(
        "--wait",
        type=float,
        default=0.0,
        help="Segundos de espera tras abrir el puerto (dar tiempo a abrir corenexus en el otro PTY).",
    )
    args = p.parse_args()

    try:
        from pymavlink import mavutil
    except ImportError:
        print("[mavlink_test_emitter] Instale pymavlink: pip install -r CoreNexus/requirements-mavlink.txt", file=sys.stderr)
        return 2

    if args.mode == "serial":
        try:
            import serial  # noqa: F401
        except ImportError:
            print("[mavlink_test_emitter] Modo serie requiere pyserial: pip install pyserial", file=sys.stderr)
            return 2

    mav = mavutil.mavlink

    if args.mode == "udp":
        conn = mavutil.mavlink_connection(
            f"udpout:{args.udp}",
            source_system=args.sysid,
            source_component=args.compid,
        )
    else:
        if not args.serial:
            print("[mavlink_test_emitter] --serial requerido en mode serial.", file=sys.stderr)
            return 1
        conn = mavutil.mavlink_connection(
            args.serial,
            baud=args.baud,
            source_system=args.sysid,
            source_component=args.compid,
        )

    if args.wait > 0:
        print(f"[mavlink_test_emitter] esperando {args.wait}s antes de enviar…", file=sys.stderr)
        time.sleep(args.wait)

    def flush_serial() -> None:
        if args.mode != "serial":
            return
        port = getattr(conn, "port", None)
        if port is not None:
            try:
                port.flush()
            except OSError:
                pass

    period = 1.0 / max(args.hz, 0.1)
    t0 = time.time()
    # Referencia WGS84 aproximada (Sevilla); el emisor orbita unos metros para ver lat/lon en vivo.
    lat0_deg = 37.2
    lon0_deg = -6.0
    print(
        f"[mavlink_test_emitter] mode={args.mode} sys={args.sysid} comp={args.compid} (Ctrl+C para salir)",
        file=sys.stderr,
    )

    while True:
        now = time.time() - t0
        boot_ms = int(now * 1000) % (2**32)

        # HEARTBEAT: custom_mode cambia para que las variables heartbeat_* no queden fijas.
        custom_mode = int(now * 2.0) % 65536
        conn.mav.heartbeat_send(
            mav.MAV_TYPE_QUADROTOR,
            mav.MAV_AUTOPILOT_GENERIC,
            mav.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            custom_mode,
            mav.MAV_STATE_ACTIVE,
            3,
        )
        # ATTITUDE: ángulos y velocidades angulares visibles en UI.
        roll = 0.25 * math.sin(now * 0.8)
        pitch = 0.18 * math.cos(now * 0.6)
        yaw = math.atan2(math.sin(now * 0.4), math.cos(now * 0.4))
        rs = 0.05 * math.cos(now * 1.2)
        ps = 0.04 * math.sin(now * 1.0)
        ys = 0.06 * math.sin(now * 0.9)
        conn.mav.attitude_send(boot_ms, roll, pitch, yaw, rs, ps, ys)
        # GLOBAL_POSITION_INT: posición y velocidades NED que evolucionan (mismo reloj que `now`).
        dlat = 3e-5 * math.sin(now * 0.25)  # ~3 m peak
        dlon = 3e-5 * math.cos(now * 0.2)
        lat_e7 = int((lat0_deg + dlat) * 1e7)
        lon_e7 = int((lon0_deg + dlon) * 1e7)
        alt_m = 100.0 + 12.0 * math.sin(now * 0.35)
        rel_m = 25.0 + 5.0 * math.cos(now * 0.5)
        alt_mm = int(alt_m * 1000.0)
        rel_mm = int(rel_m * 1000.0)
        vx_cms = int(max(-32767, min(32767, 800 * math.sin(now * 0.45))))
        vy_cms = int(max(-32767, min(32767, 600 * math.cos(now * 0.38))))
        vz_cms = int(max(-32767, min(32767, 200 * math.sin(now * 0.55))))
        hdg_cdeg = int((math.degrees(yaw) % 360.0) * 100.0) % 36000
        conn.mav.global_position_int_send(
            boot_ms,
            lat_e7,
            lon_e7,
            alt_mm,
            rel_mm,
            vx_cms,
            vy_cms,
            vz_cms,
            hdg_cdeg,
        )
        flush_serial()
        time.sleep(period)


if __name__ == "__main__":
    raise SystemExit(main())
