#!/usr/bin/env python3
"""
Clean SwachhScan_India_Washrooms.xlsx and write the static JSON files the website reads.

    python3 -m pip install -r scripts/requirements.txt
    python3 scripts/build_data.py

Pipeline (each stage is counted in the cleaning report shown on the Insights page):
  1. Read all six sheets; check the expected columns exist.
  2. Normalise text (Unicode NFC, invisible characters, whitespace, capitalisation).
  3. Canonicalise names (generic names unified; 'Pay & use' -> paid etc.), operators and cities (RapidFuzz).
  4. Validate & normalise fields: PIN codes (format + India Post zone vs state), phone numbers
     (libphonenumber), websites, prices, opening hours, yes/no/limited facilities.
  5. Geographic validation against Natural Earth land and neighbouring countries (shapely).
  6. Staleness: drop records last edited more than 15 years before the data download; for records
     5-15 years old keep the location but remove the facility details and mark them "not recently verified".
  7. De-duplicate records of the same toilet block (haversine BallTree, seed-anchored, compatibility rules).
  8. Recompute detail scores and every statistic from the cleaned data.

Writes:
    public/data/washrooms.json   cleaned records (only fields that are known are included)
    public/data/meta.json        statistics, column dictionary, sources and the cleaning report
    public/data/swachh-scan-cleaned.xlsx  the cleaned data as an Excel workbook, for download (ODbL)
    api/_data.json               washroom IDs (+ ids merged into them), names and areas for the APIs
"""
import json
import re
import sys
from collections import Counter, OrderedDict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import openpyxl
    import cleaning as C
    from hours import parse_hours
except ImportError as e:  # pragma: no cover
    sys.exit(f"Missing dependency ({e}). Install with:  python3 -m pip install -r scripts/requirements.txt")

ROOT = HERE.parent
SRC = ROOT / "SwachhScan_India_Washrooms.xlsx"
OUT = ROOT / "public" / "data"
GEO = HERE / "ref" / "natural_earth_india_region.geojson"

STALE_DROP_YEARS = 15
STALE_STRIP_YEARS = 5

FEE = {"free": "free", "paid": "paid", "5 inr": "paid", "3 inr": "paid", "1": "paid"}
ACCESS = {
    "yes": ("public", "Open to public"), "customers only": ("customers", "Customers only"), "visitors": ("customers", "Visitors only"),
    "private": ("restricted", "Private"), "permit": ("restricted", "Permit needed"), "key": ("restricted", "Ask for key"),
    "no": ("restricted", "No public access"), "residents": ("restricted", "Residents only"), "students": ("restricted", "Students only"),
    "staff": ("restricted", "Staff only"), "disabled": ("restricted", "Disabled users only"), "female": ("restricted", "Women only"),
    "male": ("restricted", "Men only"),
}
YESNO = {"yes": "yes", "no": "no", "limited": "limited", "partial": "limited", "separate": "yes"}
GENDER = {"separate men & women": "separate", "men only": "men", "women only": "women", "unisex": "unisex"}
DISPOSAL = {"flush": "Flush", "pitlatrine": "Pit latrine", "bucket": "Bucket", "chemical": "Chemical", "flush;bucket": "Flush / bucket", "pour flush": "Pour flush"}
LOCMATCH = {"Within 3 km of boundary": "near", "Island/coast: nearest state": "island"}


def norm_style(raw):
    if not raw:
        return None
    flags = set()
    for tok in re.split(r"[+;,\s]+", raw.lower()):
        if tok in ("indian", "squat"):
            flags.add("I")
        elif tok in ("western", "seated", "sitting"):
            flags.add("W")
        elif tok.startswith("urinal"):
            flags.add("U")
    return "".join(f for f in "IWU" if f in flags) or None


def sheet_rows(ws):
    return [list(r) for r in ws.iter_rows(values_only=True) if any(c is not None for c in r)]


def detail_score(it):
    keys = ["fee", "sc", "wc", "g", "bc", "ts", "hw", "op", "a"]
    return sum(1 for k in keys if it.get(k) not in (None, "", []))


class Report:
    def __init__(self):
        self.steps = []

    def add(self, stage, what, count, note=""):
        self.steps.append(OrderedDict(stage=stage, what=what, count=int(count), note=note))
        print(f"  [{stage}] {what}: {count}{(' — ' + note) if note else ''}")


def main():
    if not SRC.exists():
        sys.exit(f"Source workbook not found: {SRC}")
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    expected = ["About", "Washrooms", "By State", "By Category", "Features", "Sources"]
    missing = [s for s in expected if s not in wb.sheetnames]
    if missing:
        sys.exit(f"Workbook is missing sheets: {missing}")
    rep = Report()

    # ---------------------------------------------------------------- 1. read
    about_rows = sheet_rows(wb["About"])
    about_raw = OrderedDict((C.clean_text(r[0]), C.clean_text(r[1]) if len(r) > 1 else None) for r in about_rows[1:])
    downloaded = about_raw.get("Data downloaded")
    ref_date = C.to_date(downloaded) if downloaded else date.today()

    rows = sheet_rows(wb["Washrooms"])
    header = [C.clean_text(h) for h in rows[0]]
    need = ["Swachh Scan ID", "Name", "Category", "State / UT", "Latitude", "Longitude", "Last edited on OSM"]
    absent = [h for h in need if h not in header]
    if absent:
        sys.exit(f"Washrooms sheet is missing columns: {absent}")
    col = {h: i for i, h in enumerate(header)}
    raw = [{h: (r[col[h]] if col[h] < len(r) else None) for h in header} for r in rows[1:]]
    rep.add("Input", "Rows in the Washrooms sheet", len(raw))

    def g(r, name):
        return C.clean_text(r.get(name))

    # lookups used by the normalisers
    state_names = {(g(r, "State / UT") or "").lower() for r in raw}
    districts_by_state = {}
    for r in raw:
        if g(r, "District"):
            districts_by_state.setdefault(g(r, "State / UT"), set()).add(g(r, "District"))
    op_map = C.canonical_operators(Counter(g(r, "Operator") for r in raw if g(r, "Operator")))

    # ---------------------------------------------------------------- 2-4. normalise every record
    counts = Counter()
    items = []
    for r in raw:
        rid = g(r, "Swachh Scan ID")
        lat, lon = r.get("Latitude"), r.get("Longitude")
        if not rid or lat is None or lon is None:
            counts["no id or coordinates"] += 1
            continue
        it = OrderedDict()
        it["id"] = rid
        cat = g(r, "Category") or "Public toilet"
        raw_name = g(r, "Name")
        name, generic, inferred = C.canonical_name(raw_name, cat)
        if raw_name and name != raw_name:
            counts["names standardised"] += 1
        it["n"] = name
        it["gen"] = 1 if generic else None
        if raw_name and name != raw_name:
            it["aka"] = raw_name  # keep the original spelling searchable
        nl = g(r, "Name in local script")
        extra_names = []
        if nl and (C.is_latin(nl) or nl == name):
            counts["'local script' names that were not local script (kept only as search terms)"] += 1
            if nl != name:
                extra_names.append(nl)
            nl = None
        it["nl"] = nl
        it["c"] = cat
        it["cg"] = C.category_group(cat)
        it["s"] = 1 if (g(r, "Standalone public toilet?") or "").lower().startswith("yes") else 0
        st = g(r, "State / UT")
        it["st"] = st
        it["d"] = g(r, "District")

        raw_city = g(r, "City / Town")
        city, city_as_addr = C.canonical_city(raw_city, st, sorted(districts_by_state.get(st, [])), state_names)
        alt = []
        if raw_city and city != raw_city:
            counts["city names standardised"] += 1
            alt.append(raw_city)  # keep the old spelling searchable ("Bangalore")
        it["city"] = city

        raw_addr = g(r, "Address") or city_as_addr
        pin = g(r, "PIN code")
        pin = re.sub(r"\s", "", pin) if pin else None
        if pin and not C.valid_pin(pin, st):
            counts["invalid PIN codes removed"] += 1
            pin = None
        if not pin:
            found = C.find_pin(raw_addr)
            if found and C.valid_pin(found, st):
                pin = found
                counts["PIN codes recovered from the address"] += 1
        it["pin"] = pin
        addr = C.clean_address(raw_addr, pin, city, it["d"], st)
        if raw_addr and addr != raw_addr:
            counts["addresses tidied"] += 1
        it["a"] = addr
        it["la"] = round(float(lat), 6)
        it["lo"] = round(float(lon), 6)

        fee_raw = (g(r, "Free or paid") or "").lower()
        fee = FEE.get(fee_raw)
        price_raw = g(r, "Price") or (fee_raw if fee_raw in ("5 inr", "3 inr") else None)
        price = C.parse_price(price_raw)
        if price_raw and price is None:
            counts["implausible prices removed"] += 1
        if price == (0, 0):
            fee, price = fee or "free", None
        if fee == "free" and price:
            counts["prices that contradicted 'free' removed"] += 1
            price = None
        if price and not fee:
            fee = "paid"
        if not fee and inferred.get("fee"):
            fee = inferred["fee"]
            counts["fee inferred from the name (e.g. 'Pay & use')"] += 1
        op_raw = g(r, "Operator")
        hint = C.operator_fee_hint(op_raw) if op_raw else None
        if hint and not fee:
            fee = hint[0]
            price = price or hint[1]
            counts["fee taken from text typed into the Operator field"] += 1
        it["fee"] = fee
        it["pr"] = C.fmt_price(price)

        oh = g(r, "Opening hours")
        if oh and re.fullmatch(r"(ph|sh)(\s*,\s*(ph|sh))*(\s+(open|off|closed|unknown))?", oh.strip().lower()):
            counts["holiday-only opening hours removed (no regular hours given)"] += 1
            oh = None
        sched, approx, open_ends = parse_hours(oh)
        if oh and sched is None:
            counts["opening hours kept as text only"] += 1
            print(f"     hours kept as text for {rid}: {oh!r}")
        it["oh"] = oh
        it["sc"] = sched
        it["sca"] = 1 if approx else None
        it["soe"] = open_ends or None

        acc = ACCESS.get((g(r, "Who can use") or "").lower())
        it["acc"], it["accl"] = (acc if acc else (None, None))
        it["wc"] = YESNO.get((g(r, "Wheelchair accessible") or "").lower())
        gender = GENDER.get((g(r, "Men / women") or "").lower())
        if not gender and inferred.get("g"):
            gender = inferred["g"]
            counts["men/women inferred from the name"] += 1
        it["g"] = gender
        it["_gm"] = gender  # internal: survives the freshness step so merges can name blocks correctly
        it["bc"] = YESNO.get((g(r, "Baby changing") or "").lower())
        it["ts"] = norm_style(g(r, "Toilet style"))
        hw_raw = (g(r, "Handwashing") or "").lower()
        it["hw"] = YESNO.get(hw_raw)
        it["hws"] = 1 if hw_raw == "separate" else None
        it["soap"] = YESNO.get((g(r, "Soap") or "").lower())
        it["tp"] = YESNO.get((g(r, "Toilet paper") or "").lower())
        it["dw"] = YESNO.get((g(r, "Drinking water") or "").lower())
        it["sh"] = YESNO.get((g(r, "Shower") or "").lower())
        it["disp"] = DISPOSAL.get((g(r, "Disposal type") or "").lower())

        it["op"] = op_map.get(op_raw) if op_raw else None
        if op_raw and it["op"] != op_raw:
            counts["operator names standardised" if it["op"] else "non-operator values removed from Operator"] += 1
        phones, bad = C.clean_phones(g(r, "Phone"))
        counts["invalid phone numbers removed"] += bad
        if phones:
            counts["phone numbers validated (libphonenumber)"] += len(phones)
        it["ph"] = phones or None
        web_raw = g(r, "Website")
        it["web"] = C.clean_website(web_raw)
        if web_raw and not it["web"]:
            counts["invalid websites removed"] += 1
        it["ed"] = (g(r, "Last edited on OSM") or "")[:10] or None
        it["loc"] = LOCMATCH.get(g(r, "Location matched to state"))
        it["v"] = 1
        if raw_name and name != raw_name:
            alt.append(raw_name)
        alt += extra_names
        it["alt"] = alt or None
        items.append(it)
    for k, v in counts.items():
        rep.add("Normalise", k, v)

    # ---------------------------------------------------------------- 5. geography
    geo = C.GeoCheck(json.loads(GEO.read_text(encoding="utf-8")))
    kept, reasons = [], Counter()
    for it in items:
        why = geo.check(it["la"], it["lo"])
        if why:
            reasons[why] += 1
            print(f"     dropped {it['id']} ({it['n']}, {it['st']}): {why}")
        else:
            kept.append(it)
    rep.add("Location", "Records outside India or far out at sea (removed)", sum(reasons.values()),
            "Checked against Natural Earth 1:10m land and neighbouring countries; island and coastal washrooms are kept")
    items = kept

    # ---------------------------------------------------------------- 6. staleness
    kept, stripped = [], 0
    drop_before = C.years_before(ref_date, STALE_DROP_YEARS)    # calendar-exact cut-offs
    strip_before = C.years_before(ref_date, STALE_STRIP_YEARS)
    for it in items:
        d = C.to_date(it.get("ed") or "") or date(1900, 1, 1)
        if d < drop_before:
            continue
        if d < strip_before:
            had = any(it.get(k) not in (None, "", []) for k in C.DETAIL_KEYS)
            for k in C.DETAIL_KEYS + ["soe"]:
                it[k] = None
            it["v"] = 0
            stripped += 1 if had else 0
            counts["stale_any"] += 1
        kept.append(it)
    rep.add("Freshness", f"Records last edited more than {STALE_DROP_YEARS} years ago (removed)", len(items) - len(kept))
    rep.add("Freshness", f"Records {STALE_STRIP_YEARS}–{STALE_DROP_YEARS} years old: kept as 'not recently verified', facility details removed",
            counts["stale_any"], f"{stripped} of them had details that were removed")
    items = kept

    # ---------------------------------------------------------------- 7. de-duplicate
    for it in items:
        it["q"] = detail_score(it)
    before = len(items)
    items, groups = C.dedupe(items, radius_m=20.0)
    rep.add("Duplicates", "Records merged into the same toilet (same block mapped more than once)", before - len(items),
            f"{len(groups)} groups; e.g. separate men's and women's points 5–20 m apart become one 'separate men & women' toilet")

    # ---------------------------------------------------------------- 8. finalise
    for it in items:
        it["q"] = detail_score(it)
    items.sort(key=lambda i: (i["st"], i.get("d") or "", i["id"]))
    ids = [i["id"] for i in items]
    assert len(ids) == len(set(ids)), "duplicate ids after cleaning"
    for it in items:  # merged records: their names become extra search terms
        extra = list(dict.fromkeys((it.get("alt") or []) + [x for x in (it.get("aka"),) if x]))
        it["alt"] = [x for x in extra if x and x != it["n"]] or None
        it.pop("aka", None)
    for it in items:
        assert 5 <= it["la"] <= 38 and 66 <= it["lo"] <= 99, it["id"]
        assert it["fee"] in (None, "free", "paid") and 0 <= it["q"] <= 9
    rep.add("Output", "Washrooms published", len(items))

    clean_items = [{k: v for k, v in it.items() if v not in (None, "", []) and not k.startswith("_")} for it in items]
    write_outputs(wb, clean_items, about_raw, rep, ref_date)


def write_outputs(wb, items, about_raw, rep, ref_date):
    total = len(items)

    def table(name):
        rs = sheet_rows(wb[name])
        head = [C.clean_text(h) for h in rs[0]]
        return [OrderedDict((h, (int(v) if isinstance(v, float) and v.is_integer() else v)) for h, v in zip(head, r)) for r in rs[1:]]

    pc = lambda a, b: round(100 * a / b, 1) if b else 0.0  # noqa: E731

    # by state, recomputed from the cleaned rows
    by_state = []
    state_n = Counter(i["st"] for i in items)
    for st in sorted(state_n, key=lambda s: (-state_n[s], s)):  # deterministic order
        rows = [i for i in items if i["st"] == st]
        by_state.append(OrderedDict([
            ("State / UT", st), ("Total washrooms", len(rows)),
            ("Standalone public toilets", sum(1 for i in rows if i["s"])), ("Facilities with toilet", sum(1 for i in rows if not i["s"])),
            ("Districts with data", len({i["d"] for i in rows if i.get("d")})),
            ("% with free/paid info", pc(sum(1 for i in rows if "fee" in i), len(rows))),
            ("% with wheelchair info", pc(sum(1 for i in rows if "wc" in i), len(rows))),
            ("% with men/women info", pc(sum(1 for i in rows if "g" in i), len(rows))),
            ("% with opening hours", pc(sum(1 for i in rows if "oh" in i), len(rows))),
            ("% recently verified", pc(sum(1 for i in rows if i.get("v")), len(rows))),
        ]))
    cats = Counter(i["c"] for i in items)
    by_category = [OrderedDict([("Category", c), ("Group", C.category_group(c)), ("Washrooms", n), ("Share %", pc(n, total))])
                   for c, n in sorted(cats.items(), key=lambda x: (-x[1], x[0]))]

    FEATURES = [  # column, meaning, source/method, key, shown in the completeness chart
        ("Name", "Washroom name; generic names unified (e.g. 'Public toilet', 'Sulabh Shauchalaya')", "OSM name; RapidFuzz canonicalisation", "n", False),
        ("Name in local script", "Name in an Indian script, when mapped", "OSM name; non-local values removed", "nl", True),
        ("Category", "Standalone public toilet, or the kind of place the toilet is in", "OSM amenity/shop/tourism…", "c", False),
        ("State / UT", "From official district boundaries", "DataMeet boundaries", "st", False),
        ("District", "From official district boundaries", "DataMeet boundaries", "d", True),
        ("City / Town", "City as entered by mappers, with old names updated (Bangalore → Bengaluru)", "addr:city; alias table + fuzzy match to districts", "city", True),
        ("Address", "Street address, tidied", "addr:* tags", "a", True),
        ("PIN code", "6-digit PIN code, checked against the state's postal zone", "addr:postcode / address text", "pin", True),
        ("Free or paid", "Whether a fee is charged", "fee; 'Pay & use' names", "fee", True),
        ("Price", "Charge in rupees, when mapped and plausible", "charge", "pr", True),
        ("Opening hours", "Weekly opening hours", "opening_hours (parsed)", "oh", True),
        ("Who can use", "Public, customers only, restricted…", "access", "acc", True),
        ("Wheelchair accessible", "Yes / Limited / No", "wheelchair", "wc", True),
        ("Men / women", "Separate, women only, men only, unisex (merged across duplicate points)", "female / male / unisex", "g", True),
        ("Baby changing", "Baby changing table", "changing_table", "bc", True),
        ("Toilet style", "Indian (squat), Western (seated), urinals", "toilets:position", "ts", True),
        ("Handwashing", "Handwashing facility", "toilets:handwashing", "hw", True),
        ("Soap", "Soap available", "toilets:handwashing:soap", "soap", True),
        ("Toilet paper", "Toilet paper supplied", "toilets:paper_supplied", "tp", True),
        ("Drinking water", "Drinking water available", "drinking_water", "dw", True),
        ("Shower", "Shower available", "shower", "sh", True),
        ("Disposal type", "Flush, pit latrine, bucket, chemical…", "toilets:disposal", "disp", True),
        ("Operator", "Who runs it, with spelling variants merged", "operator; RapidFuzz clustering", "op", True),
        ("Phone", "Valid Indian phone numbers in international format", "phone; libphonenumber", "ph", True),
        ("Website", "Valid web address", "website", "web", True),
        ("Last edited on OSM", "When a volunteer last edited the record", "OSM timestamp", "ed", False),
        ("Recently verified", f"Edited within the last {STALE_STRIP_YEARS} years (older records keep only their location)", "computed", "v", False),
        ("Merged records", "Number of OpenStreetMap points combined into this washroom", "de-duplication", "ids", False),
    ]
    features = [OrderedDict([("Column", c), ("What it means", m), ("OpenStreetMap tag / source", s),
                             ("Rows filled", sum(1 for i in items if i.get(k))), ("% filled", pc(sum(1 for i in items if i.get(k)), total)), ("Chart", chart)])
                for c, m, s, k, chart in FEATURES]

    sources = table("Sources")
    sources.insert(2, OrderedDict([
        ("Source", "Natural Earth 1:10m (land, minor islands, countries — India point of view)"), ("Status", "Used to validate locations"),
        ("What it covers / how it was used", "Removes records more than 2 km inside a neighbouring country or more than 10 km out at sea. None of the current records failed this check."),
        ("Licence / terms", "Public domain."), ("Link / next step", "https://www.naturalearthdata.com/")]))
    sources.insert(3, OrderedDict([
        ("Source", "Swachh Scan cleaning pipeline (scripts/build_data.py)"), ("Status", "Applied to every record"),
        ("What it covers / how it was used", "Text normalisation, name/operator/city canonicalisation (RapidFuzz), phone validation (libphonenumber), PIN/postal-zone checks, freshness rules and spatial de-duplication (scikit-learn BallTree)."),
        ("Licence / terms", "Output remains ODbL (OpenStreetMap derivative)."), ("Link / next step", "See 'How the data was cleaned' on this page")]))

    def share(key, positive):
        known = [i for i in items if key in i]
        return {"known": len(known), "yes": sum(1 for i in known if i[key] in positive)}

    about = OrderedDict([
        ("Total washrooms", str(total)),
        ("Standalone public toilets", str(sum(1 for i in items if i["s"]))),
        ("Facilities with a toilet (petrol pumps, malls, restaurants, stations…)", str(sum(1 for i in items if not i["s"]))),
        ("States / UTs covered", str(len({i["st"] for i in items}))),
        ("Districts covered", str(len({(i["st"], i["d"]) for i in items if i.get("d")}))),
        ("Recently verified", str(sum(1 for i in items if i.get("v")))),
        ("Data downloaded", about_raw.get("Data downloaded")),
        ("Important", "These are the washrooms volunteers have mapped on OpenStreetMap, cleaned and de-duplicated. It is not every washroom in India: coverage is strong in big cities and thin in small towns. Records last edited 5–15 years ago keep only their location. Cleanliness ratings come from Swachh Scan users and are shown in the app, not in this file."),
        ("Credit required", about_raw.get("Credit required")),
    ])
    years = Counter(int(i["ed"][:4]) for i in items if i.get("ed"))
    meta = OrderedDict(
        title=C.clean_text(sheet_rows(wb["About"])[0][0]),
        about=about,
        sheets=OrderedDict([
            ("About", "Totals, licence and notes"),
            ("Washrooms", "Every cleaned washroom, one row each, with location, known details and source link"),
            ("By State", "Counts per state/UT, freshness and how complete the details are"),
            ("By Category", "Counts per type of place, with category groups"),
            ("Columns", "What each column means, where it comes from and how often it is filled"),
            ("Cleaning", "What each cleaning step changed"),
            ("Sources", "Where the data came from, licences, method, and sources not included"),
        ]),
        byState=by_state, byCategory=by_category, features=features, sources=sources,
        stats=OrderedDict(
            detailScore=[sum(1 for i in items if i["q"] == s) for s in range(10)],
            editedByYear=sorted([[y, c] for y, c in years.items()]),
            known=OrderedDict(
                free=share("fee", {"free"}), wheelchair=share("wc", {"yes", "limited"}),
                women=share("g", {"separate", "women", "unisex"}), baby=share("bc", {"yes", "limited"}),
                western=share("ts", {"W", "IW", "WU", "IWU"}), handwashing=share("hw", {"yes"}), water=share("dw", {"yes"}),
                open247={"known": sum(1 for i in items if "sc" in i), "yes": sum(1 for i in items if i.get("sc") == "24/7")},
            ),
        ),
        cleaning=OrderedDict(referenceDate=ref_date.isoformat(), staleStripYears=STALE_STRIP_YEARS, staleDropYears=STALE_DROP_YEARS, steps=rep.steps),
        built=date.today().isoformat(),
        count=total,
    )

    OUT.mkdir(parents=True, exist_ok=True)
    # read the previous build BEFORE overwriting it: ids that disappear are kept working as aliases
    prev_items, prev_alias = [], {}
    try:
        prev_items = json.loads((OUT / "washrooms.json").read_text(encoding="utf-8"))["items"]
        prev_file = ROOT / "api" / "_data.json"
        if not prev_file.exists():
            prev_file = ROOT / "api" / "_ids.json"  # older builds
        prev = json.loads(prev_file.read_text(encoding="utf-8"))
        prev_alias = prev.get("alias", {}) if isinstance(prev, dict) else {}
    except (OSError, ValueError, KeyError):
        pass
    merge_alias = {a: i["id"] for i in items for a in i.get("ids", []) if a != i["id"]}
    history_alias = carry_forward_ids(items, prev_items, prev_alias)
    alias = dict(sorted({**history_alias, **merge_alias}.items()))
    if history_alias:
        print(f"  [Output] {len(history_alias)} ids from earlier builds kept working as aliases")

    (OUT / "washrooms.json").write_text(json.dumps({"downloaded": about_raw.get("Data downloaded"), "alias": dict(sorted(history_alias.items())), "items": items},
                                                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    write_workbook(OUT / "swachh-scan-cleaned.xlsx", items, meta)
    old_copy = OUT / SRC.name  # earlier builds published the raw workbook; only cleaned data is published now
    if old_copy.exists():
        old_copy.unlink()
    write_api_index(ROOT / "api" / "_data.json", items, alias)
    old_ids = ROOT / "api" / "_ids.json"  # replaced by _data.json
    if old_ids.exists():
        old_ids.unlink()
    size = (OUT / "washrooms.json").stat().st_size
    print(f"\nWrote {total} washrooms ({size / 1e6:.2f} MB), meta.json, swachh-scan-cleaned.xlsx and api/_data.json")


def write_api_index(path, items, alias):
    """Compact index the serverless API uses: which ids are real, where each washroom is, and what it is called.

    items: {id: [name, state index, district index, city, lat, lon, standalone 1/0]}. The civic dashboard scopes
    officers to states/districts/cities with it, and the business pages show washroom names from it.
    """
    states = sorted({i["st"] for i in items})
    districts = sorted({i.get("d") or "" for i in items})
    si = {s: n for n, s in enumerate(states)}
    di = {d: n for n, d in enumerate(districts)}
    idx = {i["id"]: [i["n"], si[i["st"]], di[i.get("d") or ""], i.get("city") or "", round(i["la"], 6), round(i["lo"], 6), 1 if i["s"] else 0]
           for i in items}
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps({"states": states, "districts": districts, "alias": alias, "items": idx},
                               ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def carry_forward_ids(items, prev_items, prev_alias):
    """Old ids (previous records and their aliases) that no longer exist -> the current record that took them over.

    Ratings in the database and printed QR stickers use ids. When OpenStreetMap deletes or merges points
    between data refreshes, an id can disappear; it is then pointed at the current record that contains
    another point of its old group, or failing that the nearest current toilet of the same kind within 20 m.
    """
    import math
    current = {i["id"] for i in items}
    member_of = {m: i["id"] for i in items for m in (i.get("ids") or [i["id"]])}
    out = {}
    for old in prev_items:
        group = old.get("ids") or [old["id"]]
        olds = set(group) | {a for a, t in prev_alias.items() if t == old["id"]}
        for x in sorted(olds):
            if x in member_of:
                continue
            target = next((member_of[m] for m in group if m in member_of), None)
            if target is None:
                best = None
                for i in items:
                    if i["s"] != old.get("s"):
                        continue
                    dy = (i["la"] - old["la"]) * 110540
                    dx = (i["lo"] - old["lo"]) * 111320 * math.cos(math.radians(old["la"]))
                    d = math.hypot(dx, dy)
                    if d <= 20 and (best is None or d < best[0]):
                        best = (d, i["id"])
                target = best[1] if best else None
            if target in current:
                out[x] = target
    return out


def write_workbook(path, items, meta):
    """The cleaned data as an Excel workbook with the same kind of sheets as the source."""
    L_G = {"separate": "Separate men & women", "men": "Men only", "women": "Women only", "unisex": "Unisex"}

    def style(ts):
        return " + ".join({"I": "Indian (squat)", "W": "Western (seated)", "U": "Urinals"}[f] for f in (ts or ""))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "About"
    rows = [["Swachh Scan — India Public Washroom Database (cleaned)", None], [None, None]]
    rows += [[k, v] for k, v in meta["about"].items()]
    rows += [[None, None], ["Cleaning reference date", meta["cleaning"]["referenceDate"]],
             ["Licence", "Data © OpenStreetMap contributors, Open Database Licence (ODbL) 1.0"]]
    for r in rows:
        ws.append(r)
    cols = [
        ("Swachh Scan ID", "id"), ("Merged OSM IDs", lambda i: " ".join(i.get("ids", [i["id"]]))), ("Name", "n"),
        ("Name in local script", "nl"), ("Category", "c"), ("Category group", "cg"), ("Standalone public toilet", lambda i: "Yes" if i["s"] else "No"),
        ("State / UT", "st"), ("District", "d"), ("City / Town", "city"), ("Address", "a"), ("PIN code", "pin"),
        ("Latitude", "la"), ("Longitude", "lo"), ("Free or paid", "fee"), ("Price", "pr"), ("Opening hours", "oh"),
        ("Who can use", "accl"), ("Wheelchair accessible", "wc"), ("Men / women", lambda i: L_G.get(i.get("g"))),
        ("Baby changing", "bc"), ("Toilet style", lambda i: style(i.get("ts")) or None), ("Handwashing", "hw"), ("Soap", "soap"),
        ("Toilet paper", "tp"), ("Drinking water", "dw"), ("Shower", "sh"), ("Disposal type", "disp"), ("Operator", "op"),
        ("Phone", lambda i: "; ".join(i.get("ph") or []) or None), ("Website", "web"), ("Last edited on OSM", "ed"),
        ("Recently verified", lambda i: "Yes" if i.get("v") else "No"), ("Detail score (0-9)", "q"),
        ("Source URL", lambda i: "https://www.openstreetmap.org/{}/{}".format({"N": "node", "W": "way", "R": "relation"}[i["id"][4]], i["id"][5:])),
    ]
    ws = wb.create_sheet("Washrooms")
    ws.append([c for c, _ in cols])
    for i in items:
        ws.append([(f(i) if callable(f) else i.get(f)) for _, f in cols])
    for name, data in (("By State", meta["byState"]), ("By Category", meta["byCategory"])):
        ws = wb.create_sheet(name)
        ws.append(list(data[0].keys()))
        for r in data:
            ws.append(list(r.values()))
    ws = wb.create_sheet("Columns")
    ws.append(["Column", "What it means", "Source / method", "Rows filled", "% filled"])
    for f in meta["features"]:
        ws.append([f["Column"], f["What it means"], f["OpenStreetMap tag / source"], f["Rows filled"], f["% filled"]])
    ws = wb.create_sheet("Cleaning")
    ws.append(["Stage", "What happened", "Records", "Note"])
    for st in meta["cleaning"]["steps"]:
        ws.append([st["stage"], st["what"], st["count"], st.get("note") or None])
    ws = wb.create_sheet("Sources")
    ws.append(list(meta["sources"][0].keys()))
    for r in meta["sources"]:
        ws.append(list(r.values()))
    wb.save(path)
    _make_reproducible(path, meta["cleaning"]["referenceDate"])


def _make_reproducible(path, ref_date):
    """openpyxl stamps the build time into the file; pin every timestamp to the data date so rebuilds are byte-identical."""
    import zipfile
    stamp = f"{ref_date}T00:00:00Z"
    with zipfile.ZipFile(path) as z:
        entries = [(i.filename, z.read(i.filename)) for i in z.infolist()]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            if name == "docProps/core.xml":
                data = re.sub(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(<)", rb"\g<1>" + stamp.encode() + rb"\g<2>", data)
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)


if __name__ == "__main__":
    main()
