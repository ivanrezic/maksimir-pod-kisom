"""Convert Overpass JSON dumps into a compact local-metre scene description.

Frame: origin at the centre of the current Maksimir pitch, x = east, z = south (metres).
"""
import json, math, sys

LAT0, LON0 = 45.8186909, 16.0179792
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110540
R_MAX = 1500.0
STADIUM_WAYS = {37017172, 37017173, 37017174, 37017175, 29574254, 904386310, 904386311,
                904386312, 904386313, 904386314, 904386315, 29574648}


def xz(p):
    return ((p["lon"] - LON0) * KX, -(p["lat"] - LAT0) * KY)


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    if pts[0] == pts[-1] or math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 0.01:
        ring = pts[:-1]
        if len(ring) < 3:
            return ring
        far = max(range(len(ring)), key=lambda i: math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]))
        a = simplify(ring[:far + 1], tol)
        b = simplify(ring[far:] + [ring[0]], tol)
        return a[:-1] + b[:-1]
    def rdp(a, b):
        (x1, z1), (x2, z2) = pts[a], pts[b]
        dx, dz = x2 - x1, z2 - z1
        L = math.hypot(dx, dz) or 1e-9
        best, idx = -1, -1
        for i in range(a + 1, b):
            x, z = pts[i]
            d = abs(dz * (x - x1) - dx * (z - z1)) / L
            if d > best:
                best, idx = d, i
        if best > tol:
            return rdp(a, idx)[:-1] + rdp(idx, b)
        return [pts[a], pts[b]]
    return rdp(0, len(pts) - 1)


def rnd(pts):
    return [[round(x, 1), round(z, 1)] for x, z in pts]


def near(pts, r=R_MAX):
    return any(math.hypot(x, z) < r for x, z in pts)


def join_rings(ways):
    """Stitch relation member ways into closed rings."""
    segs = [list(w) for w in ways if len(w) > 1]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == ring[-1]:
                    ring += s[::-1][1:]; segs.pop(i); changed = True; break
                if s[-1] == ring[0]:
                    ring = s[:-1] + ring; segs.pop(i); changed = True; break
                if s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring; segs.pop(i); changed = True; break
        rings.append(ring)
    return rings


def hull(pts):
    pts = sorted(set(pts))
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return [list(p) for p in lo[:-1] + hi[:-1]]


def main(paths, out):
    seen = {}
    for p in paths:
        for e in json.load(open(p))["elements"]:
            seen[(e["type"], e["id"])] = e
    els = list(seen.values())

    data = {"forest": [], "water": [], "grass": [], "pitches": [], "roads": [], "tram": [],
            "buildings": [], "labels": []}

    for e in els:
        t = e.get("tags", {})
        if e["type"] == "relation":
            if t.get("landuse") == "forest" or t.get("natural") in ("wood", "water"):
                outers = [[xz(p) for p in m.get("geometry", [])] for m in e.get("members", [])
                          if m.get("role") == "outer" and m.get("geometry")]
                key = "water" if t.get("natural") == "water" else "forest"
                for ring in join_rings([[(round(a, 2), round(b, 2)) for a, b in o] for o in outers]):
                    if len(ring) > 3 and near(ring):
                        data[key].append(rnd(simplify(ring, 4 if key == "forest" else 1.5)))
                        if key == "water" and t.get("name"):
                            cx = sum(p[0] for p in ring) / len(ring); cz = sum(p[1] for p in ring) / len(ring)
                            data["labels"].append({"t": t["name"].replace(" Maksimirsko jezero", " jezero"),
                                                   "x": round(cx), "z": round(cz), "k": "water"})
            continue
        if e["type"] != "way" or e["id"] in STADIUM_WAYS:
            continue
        g = e.get("geometry") or []
        if len(g) < 2:
            continue
        pts = [xz(p) for p in g]
        if not near(pts):
            continue
        hw = t.get("highway")
        if t.get("natural") == "water":
            data["water"].append(rnd(simplify(pts, 1.5)))
        elif t.get("landuse") == "forest" or t.get("natural") == "wood":
            data["forest"].append(rnd(simplify(pts, 4)))
        elif t.get("leisure") == "park" or t.get("landuse") == "grass":
            if near(pts, 1200):
                data["grass"].append(rnd(simplify(pts, 2)))
        elif t.get("leisure") in ("pitch", "track") and t.get("sport") in ("soccer", None, "athletics", "running"):
            if near(pts, 1000) and len(pts) >= 4:
                data["pitches"].append({"s": t.get("sport") or "", "p": rnd(simplify(pts, 0.5))})
        elif hw:
            cls = {"trunk": 0, "primary": 0, "secondary": 0, "secondary_link": 1, "tertiary": 1,
                   "tertiary_link": 1, "residential": 2, "unclassified": 2, "pedestrian": 3,
                   "footway": 4, "path": 4}.get(hw)
            if cls is None:
                continue
            r = 1300 if cls < 4 else 1100
            if near(pts, r):
                data["roads"].append({"c": cls, "n": t.get("name", ""), "p": rnd(simplify(pts, 1.5))})
        elif t.get("railway") == "tram":
            data["tram"].append(rnd(simplify(pts, 1)))
        if "building" in t and near(pts, 1100):
            lv = t.get("building:levels")
            h = None
            try:
                if "height" in t:
                    h = float(t["height"].split()[0])
                elif lv:
                    h = float(lv) * 3.1 + 1.5
            except ValueError:
                pass
            if h is None:
                kind = t["building"]
                h = {"house": 8, "detached": 8, "garage": 3, "garages": 3, "shed": 3, "roof": 4,
                     "apartments": 16, "residential": 10, "commercial": 10, "industrial": 9,
                     "school": 12, "university": 14, "church": 18, "hospital": 18}.get(kind, 8)
            data["buildings"].append({"h": round(h, 1), "p": rnd(simplify(pts[:-1] if pts[0] == pts[-1] else pts, 0.6))})
            nm = t.get("name")
            if nm and t.get("building") == "triumphal_arch":
                cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
                data["labels"].append({"t": "Glavni ulaz u park", "x": round(cx), "z": round(cz), "k": "poi"})
        if t.get("natural") == "water" and t.get("name"):
            cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
            data["labels"].append({"t": t["name"].replace(" Maksimirsko jezero", " jezero"), "x": round(cx), "z": round(cz), "k": "water"})

    # Drop forest blobs far south of the site, then approximate the park grounds as the
    # convex hull of the park forest north of Maksimirska cesta (OSM has no park boundary).
    data["forest"] = [g for g in data["forest"] if sum(p[1] for p in g) / len(g) < 500]
    data["park"] = hull([tuple(p) for g in data["forest"] for p in g
                         if -480 < p[0] < 1300 and -1500 < p[1] < -60])
    data["labels"].append({"t": "Meteorološka postaja Zagreb-Maksimir", "x": 1229, "z": -307, "k": "poi"})

    json.dump(data, open(out, "w"), separators=(",", ":"))
    for k, v in data.items():
        print(k, len(v))


if __name__ == "__main__":
    main(sys.argv[1:-1], sys.argv[-1])
