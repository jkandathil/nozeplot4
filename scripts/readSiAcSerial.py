#!/usr/bin/env python3
"""
Read lines from SiAC / ASAU USB serial. Use passive mode if the device already streams.

Usage:
  pip3 install pyserial
  python3 scripts/readSiAcSerial.py /dev/tty.usbmodem5103005D00531
  python3 scripts/readSiAcSerial.py /dev/tty.usbmodem5103005D00531 --seconds 15 --no-send
  python3 scripts/readSiAcSerial.py /dev/tty.usbmodem5103005D00531 --telemetry 1000
"""
from __future__ import annotations

import argparse
import json
import sys
import time


def build_rpc_line(method: str, params: dict | None) -> str:
    payload: dict = {"method": method}
    if params is not None:
        payload["params"] = params
    inner = json.dumps(payload, separators=(",", ":"))
    return "rpc send " + json.dumps(inner) + "\r\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="Read serial output from SiAC/ASAU device.")
    ap.add_argument("port", help="e.g. /dev/tty.usbmodem… or COM3")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=10.0, help="How long to read")
    ap.add_argument(
        "--no-send",
        action="store_true",
        help="Do not send anything; only read what the firmware already prints",
    )
    ap.add_argument(
        "--telemetry",
        type=int,
        metavar="PERIOD_MS",
        default=None,
        help="Send TELEMETRY with this period (ms); default with --no-send off is 1000",
    )
    args = ap.parse_args()

    try:
        import serial
    except ImportError:
        print("Install pyserial: pip3 install pyserial", file=sys.stderr)
        return 1

    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.1)
    except OSError as e:
        print(f"Open failed: {e}", file=sys.stderr)
        return 1

    time.sleep(0.15)
    ser.reset_input_buffer()

    if not args.no_send:
        period = args.telemetry if args.telemetry is not None else 1000
        line = build_rpc_line(
            "TELEMETRY",
            {"period": period, "includeRawValues": 0, "outputFormat": 0},
        )
        print(f"--- sending ({repr(line[:80])}...) ---", file=sys.stderr)
        ser.write(line.encode("utf-8"))
        ser.flush()

    deadline = time.monotonic() + args.seconds
    buf = ""
    print("--- reading until %.1fs elapsed ---" % args.seconds, file=sys.stderr)

    while time.monotonic() < deadline:
        chunk = ser.read(4096)
        if chunk:
            buf += chunk.decode("utf-8", errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                print(line.rstrip("\r"))
        else:
            time.sleep(0.02)

    if buf.strip():
        print(buf.rstrip("\r\n"), end="" if buf.endswith("\n") else "\n")

    ser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
