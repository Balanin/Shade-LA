import argparse
import base64
import bz2
import gzip
import lzma
import pathlib
import re
import zlib


def _decompress(data: bytes) -> bytes | None:
    if data[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(data)
        except Exception:
            return None
    for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS, 15 + 32):
        try:
            return zlib.decompress(data, wbits)
        except Exception:
            continue
    try:
        return bz2.decompress(data)
    except Exception:
        pass
    try:
        return lzma.decompress(data)
    except Exception:
        pass
    return None


def extract_clusters(ghx_path: pathlib.Path) -> list[bytes]:
    xml = ghx_path.read_text(encoding="utf-8", errors="ignore")
    raw_items = re.findall(r'<item name="ClusterDocument"[^>]*>(.*?)</item>', xml, flags=re.S)
    out: list[bytes] = []
    for raw in raw_items:
        s = re.sub(r"\s+", "", raw)
        data = base64.b64decode(s, validate=False)
        dec = _decompress(data)
        out.append(dec if dec is not None else data)
    return out


def list_component_names(cluster_xml: str, limit: int = 120) -> list[str]:
    nicks = set(re.findall(r'<item name="NickName"[^>]*>\s*([^<]{1,120})\s*<', cluster_xml))
    names = set(re.findall(r'<item name="Name"[^>]*>\s*([^<]{1,120})\s*<', cluster_xml))
    merged = sorted({x.strip() for x in (list(nicks) + list(names)) if x and x.strip()})
    return merged[:limit]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ghx", nargs="?", default="public/gh/123.ghx")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--out-dir", default=".ghx_cluster_extract")
    args = ap.parse_args()

    ghx_path = pathlib.Path(args.ghx)
    clusters = extract_clusters(ghx_path)
    print("cluster_count", len(clusters))

    out_dir = pathlib.Path(args.out_dir)
    if args.write:
        out_dir.mkdir(parents=True, exist_ok=True)

    for i, dec in enumerate(clusters):
        head = dec[:24]
        head_hex = head.hex(" ")
        head_ascii = "".join(chr(b) if 32 <= b < 127 else "." for b in head)
        print(f"\n# cluster {i} bytes {len(dec)}")
        print("head_hex", head_hex)
        print("head_ascii", head_ascii)

        txt = dec.decode("utf-8", "ignore")
        if "<Archive" not in txt and "<chunks" not in txt:
            print("not_xml_archive")
            if args.write:
                (out_dir / f"cluster_{i}.bin").write_bytes(dec)
            continue

        names = list_component_names(txt)
        print("components_found", len(names))
        for n in names:
            print(n)
        if args.write:
            (out_dir / f"cluster_{i}.xml").write_text(txt, encoding="utf-8", errors="ignore")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
