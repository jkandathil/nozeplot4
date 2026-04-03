#!/usr/bin/env python3
"""
Open a USB serial device, send SiAC64 shell RPC (Telemetry.md style), print response.

Usage:
  pip3 install pyserial
  python3 scripts/probeSiAc64Serial.py /dev/tty.usbmodem5103005D00531
  python3 scripts/probeSiAc64Serial.py /dev/tty.usbmodem5103005D00531 --period 1000
"""
from __future__ import annotations

import argparse
import json
import sys
import time


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("port", help="Serial device, e.g. /dev/tty.usbmodem… or COM3")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument(
        "--period",
        type=int,
        default=None,
        help="If set, TELEMETRY.params.period (ms). If omitted, one-shot TELEMETRY.",
    )
    p.add_argument("--read-ms", type=int, default=3500, help="Read window after send (ms)")
    args = p.parse_args()

    try:
        import serial
    except ImportError:
        print("Install pyserial: pip3 install pyserial", file=sys.stderr)
        return 1

    payload = {"method": "TELEMETRY"}
    if args.period is not None:
        payload["params"] = {"period": int(args.period)}
    inner = json.dumps(payload, separators=(",", ":"))
    line = "rpc send " + json.dumps(inner) + "\r\n"

    print("--- bytes to send (repr) ---")
    print(repr(line))
    print("--- human ---")
    print(line.replace("\r\n", "\\r\\n\n").strip())

    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.05)
    except OSError as e:
        print(f"Open failed: {e}", file=sys.stderr)
        return 1

    time.sleep(0.15)
    ser.reset_input_buffer()
    ser.write(line.encode("utf-8"))
    ser.flush()
    time.sleep(0.05)

    buf = bytearray()
    end = time.monotonic() + args.read_ms / 1000.0
    while time.monotonic() < end:
        chunk = ser.read(4096)
        if chunk:
            buf.extend(chunk)
        else:
            time.sleep(0.02)

    ser.close()

    text = bytes(buf).decode("utf-8", errors="replace")
    print("--- raw response (%d bytes) ---" % len(buf))
    print(text[:12000] if len(text) > 12000 else text)
    if len(text) > 12000:
        print(f"\n... truncated ({len(text)} chars total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
