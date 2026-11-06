"""
Cleaning and preprocessing steps for the Swachh Scan washroom data (used by build_data.py).

Methods
- Text: Unicode NFC normalisation, removal of control / zero-width / bidi characters, whitespace collapsing.
- Geography: point-in-polygon tests with shapely (prepared geometries) against Natural Earth 1:10m land and
  neighbouring-country polygons (India point of view); haversine distances.
- Entity resolution: fuzzy string matching with RapidFuzz (token-set / weighted ratios) against canonical
  vocabularies, plus frequency-based clustering of spelling variants.
- Phone numbers: Google's libphonenumber (Python port `phonenumbers`): parse, validate, format.
- PIN codes: format check plus India Post zone-to-state consistency check.
- De-duplication: spatial blocking with a haversine BallTree (scikit-learn), seed-anchored grouping
  (no chaining) and pairwise compatibility rules on category, name similarity and men/women split.
"""
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from urllib.parse import urlsplit, urlunsplit

import numpy as np
import phonenumbers
from rapidfuzz import fuzz, process
from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.validation import make_valid
from sklearn.neighbors import BallTree

EARTH_M = 6_371_000

# ---------------------------------------------------------------- text

_INVISIBLE = re.compile(r"[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]")


def clean_text(v):
    """NFC-normalise, strip invisible characters, collapse whitespace; '' -> None."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = unicodedata.normalize("NFC", str(v))
    s = re.sub(r"[\t\n\r\f\v]+", " ", s)  # line breaks separate words; don't glue them together
    s = _INVISIBLE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip(" ,;")
    return s or None


def is_latin(s):
    return all(ord(c) < 0x250 for c in s if c.isalpha())


ACRONYMS = {"KFC", "DDA", "IHCL", "HRTC", "IKEA", "KSRTC", "MSRTC", "APSRTC", "TSRTC", "BMC", "TMC", "NMMC", "MBMC", "GVMC",
            "BBMP", "BMRCL", "SBM", "MCD", "NDMC", "SDMC", "IIT", "IITK", "DMRC", "HP", "BP", "IOCL", "HPCL", "BPCL", "CSE",
            "VIP", "HMB", "MMC", "PMC", "GHMC", "CIDCO", "MIDC", "NHAI", "ISBT", "AIIMS", "NGO", "ATM", "USAF", "DLF", "ITC",
            "ESIC", "LIC", "SBI", "PNB", "BSNL", "DTC", "MTDC", "KTDC", "ITDC", "ASI", "UP", "MP", "CR", "WC", "PWD", "NIT", "IIM"}


ACRONYMS |= {"KK", "HS", "SSS", "KMDA", "DGT", "GH", "PG", "CMC", "BDA", "HUDA", "GMC", "AMC", "SMC", "VMC", "KMC", "NMC"}


def tidy_case(s):
    """ALL CAPS or all lowercase Latin text -> Title Case, run by run of letters, keeping acronyms (GVMC, DGT),
    letters inside codes (AB-0-608) and dotted initials (M.G.M.A). Mixed-case text is left as typed,
    apart from a leading lowercase abbreviation ("st. Mary's" -> "St. Mary's")."""
    if not s or not is_latin(s):
        return s
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return s
    all_up = all(c.isupper() for c in letters)
    all_low = all(c.islower() for c in letters)
    if not (all_up or all_low):
        return re.sub(r"^([a-z]{1,3})\.", lambda m: m.group(1).capitalize() + ".", s)
    words = s.split(" ")
    if all_up and len(words) == 1 and len(words[0]) <= 6 and words[0].isalpha():
        return s  # a lone short all-caps word is an acronym (MSRTC, IKEA)
    small = {"of", "and", "the", "in", "at", "on", "by", "for"}
    out = []
    for wi, w in enumerate(words):
        if re.fullmatch(r"(?:[A-Za-z]\.){2,}[A-Za-z]?\.?", w):
            out.append(w.upper())  # dotted initials
            continue
        has_digit = bool(re.search(r"\d", w))
        parts = re.findall(r"[A-Za-z]+|[^A-Za-z]+", w)
        res = []
        for pi, part in enumerate(parts):
            if not part.isalpha():
                res.append(part)
                continue
            up = part.upper()
            prev = parts[pi - 1] if pi else ""
            nxt = parts[pi + 1] if pi + 1 < len(parts) else ""
            if prev.endswith("'"):
                res.append(part.lower())  # Mary's
            elif up in ACRONYMS:
                res.append(up)
            elif len(part) >= 3 and not re.search(r"[AEIOUY]", up) and not nxt.startswith("."):
                res.append(up)  # vowel-less run: an acronym (DGT, SSS, GVMC)
            elif has_digit and len(part) <= 3:
                res.append(up)  # letters inside a code: AB-0-608, 2B
            elif wi and pi == 0 and part.lower() in small and len(parts) == 1:
                res.append(part.lower())
            else:
                res.append(part[:1].upper() + part[1:].lower())
        out.append("".join(res))
    return " ".join(out)


# ---------------------------------------------------------------- geography

class GeoCheck:
    """Flags gross location errors: well inside another country, or far out at sea."""

    def __init__(self, geojson, foreign_km=2.0, sea_km=10.0):
        land, countries = [], []
        for f in geojson["features"]:
            g = make_valid(shape(f["geometry"]))  # coordinate rounding can leave tiny self-intersections
            if f["properties"]["kind"] == "land":
                land.append(g)
            else:
                countries.append((f["properties"]["name"], g))
        self.land = unary_union(land)
        self.land_p = prep(self.land)
        self.countries = [(n, g, prep(g)) for n, g in countries]
        self.foreign_km, self.sea_km = foreign_km, sea_km

    @staticmethod
    def _deg_to_km(lat):
        return 111.32 * math.cos(math.radians(lat)), 110.54

    def _dist_km(self, p, geom, lat):
        kx, ky = self._deg_to_km(lat)
        # distance to the polygon boundary, approximated in a local equirectangular frame
        from shapely.ops import nearest_points
        a, b = nearest_points(p, geom.boundary if geom.geom_type != "Point" else geom)
        return math.hypot((a.x - b.x) * kx, (a.y - b.y) * ky)

    def check(self, lat, lon):
        """-> None if fine, else a reason string."""
        if not (5.0 <= lat <= 38.0 and 66.0 <= lon <= 99.0):
            return "outside India's bounding box"
        p = Point(lon, lat)
        for name, g, gp in self.countries:
            if gp.contains(p) and self._dist_km(p, g, lat) > self.foreign_km:
                return f"inside {name}"
        if not self.land_p.contains(p):
            d = self._dist_km(p, self.land, lat)
            if d > self.sea_km:
                return f"{d:.0f} km out at sea"
        return None


# ---------------------------------------------------------------- names

# A name is generic only if EVERY word is a generic toilet word (fuzzy-matched for misspellings).
GENERIC_TOKENS = {
    "public", "toilet", "toilets", "washroom", "washrooms", "restroom", "restrooms", "rest", "room", "wc", "lavatory",
    "urinal", "urinals", "block", "complex", "sulabh", "sulab", "sulhab", "shulab", "international", "shauchalaya",
    "shauchalay", "sauchalay", "sauchalaya", "shochalaya", "sochalaya", "shouchalaya", "swachalaya", "sbm", "swachh",
    "swacch", "swach", "swachch", "bharat", "bharath", "mission", "abhiyan", "abhiyaan", "pay", "and", "use", "n", "&",
    "free", "community", "e", "etoilet", "ladies", "gents", "women", "womens", "men", "mens", "female", "male", "s", "for",
}
DEVANAGARI = {"सुलभ": "sulabh", "शौचालय": "shauchalaya", "सार्वजनिक": "public", "स्वच्छ": "swachh", "भारत": "bharat",
              "महिला": "ladies", "पुरुष": "gents", "प्रसाधन": "toilet", "सामुदायिक": "community"}
_VOCAB = sorted(t for t in GENERIC_TOKENS if len(t) >= 4)
GENERIC_SET = {"Public toilet", "Sulabh Shauchalaya", "Swachh Bharat toilet", "Pay & use toilet", "Free toilet",
               "Women's toilet", "Men's toilet", "Community toilet", "e-Toilet"}


def _generic_tokens(low):
    for dev, lat in DEVANAGARI.items():
        low = low.replace(dev, f" {lat} ")
    if re.search(r"\d", low):
        return None  # "Toilet 1", "Block 2": numbered toilets are specific places
    toks = re.findall(r"[a-z]+|&", low)
    if not toks or re.search(r"[^\x00-\x7f\s]", re.sub("|".join(DEVANAGARI), "", low)):
        return None  # empty, or other non-Latin words we can't judge
    fixed = []
    for t in toks:
        if t in GENERIC_TOKENS:
            fixed.append(t)
            continue
        hit = process.extractOne(t, _VOCAB, scorer=fuzz.ratio, score_cutoff=80) if len(t) >= 4 else None  # one swapped pair ≈ 83
        if not hit:
            return None  # a word that isn't generic: this is a specific name
        fixed.append(hit[0])
    return fixed


def _generic_class(toks):
    t = set(toks)
    if t & {"sulabh", "sulab", "sulhab", "shulab"}:
        return "Sulabh Shauchalaya"
    if t & {"sbm", "swachh", "swacch", "swach", "swachch", "bharat", "bharath"}:
        return "Swachh Bharat toilet"
    if "pay" in t:
        return "Pay & use toilet"
    if "free" in t:
        return "Free toilet"
    women, men = bool(t & {"ladies", "women", "womens", "female"}), bool(t & {"gents", "men", "mens", "male"})
    if women and not men:
        return "Women's toilet"
    if men and not women:
        return "Men's toilet"
    if "community" in t:
        return "Community toilet"
    if t & {"e", "etoilet"}:
        return "e-Toilet"
    return "Public toilet"


def place_label(category):
    """'Shop (clothes)' -> 'Clothes shop', 'Building (bus station)' -> 'Bus station', 'Other (platform)' -> 'Platform'."""
    m = re.match(r"^(shop|building|other|leisure|tourism|office)\s*\((.+)\)$", category or "", re.I)
    if not m:
        return category
    kind, inner = m.group(1).lower(), m.group(2)
    label = f"{inner} shop" if kind == "shop" else f"{inner} office" if kind == "office" else inner
    return label[:1].upper() + label[1:]


def canonical_name(raw, category):
    """-> (display name, is_generic, inferred dict). Generic names are unified; specific names are tidied."""
    inferred = {}
    if not raw:
        return place_label(category) or "Public toilet", True, inferred
    auto = re.match(r"^(.*) \(toilet available\)$", raw)
    if auto:  # names the source generated for unnamed facilities: "Building (bus station)" -> "Bus station"
        return place_label(auto.group(1)), True, inferred
    toks = _generic_tokens(raw.lower())
    if toks is None or len(toks) > 7:
        return tidy_case(raw), False, inferred
    canon = _generic_class(toks)
    t = set(toks)
    if canon == "Pay & use toilet":
        inferred["fee"] = "paid"
    elif canon == "Free toilet":
        inferred["fee"] = "free"
    elif canon == "Women's toilet":
        inferred["g"] = "women"
    elif canon == "Men's toilet":
        inferred["g"] = "men"
    elif t & {"ladies", "women", "womens", "female"} and t & {"gents", "men", "mens", "male"}:
        inferred["g"] = "separate"
    return canon, True, inferred


# ---------------------------------------------------------------- operators

OPERATOR_RULES = [
    ("Sulabh International", r"sulabh|sulhab|\bsulab\b"),
    ("BBMP (Bruhat Bengaluru Mahanagara Palike)", r"^bbmp\b|bruhat\s+bengaluru|ಬೃಹತ್ ಬೆಂಗಳೂರು"),
    ("Municipal Corporation of Delhi", r"^(mcd|sdmc|ndmc south|municipal corporation of delhi)$"),
    ("New Delhi Municipal Council", r"^(ndmc|new delhi municipal (council|corporation))$"),
    ("Swachh Bharat Mission", r"^(sbm|swa+c+h* bhar[a-z]* (mission|abhiyaan))$"),
    ("Indian Oil", r"^(indian oil|iocl?|indian oil corporation( ltd\.?)?)$"),
    ("Hindustan Petroleum", r"^(hp|hpcl|hindustan petroleum( corporation( ltd\.?)?)?)$"),
    ("Bharat Petroleum", r"^(bp|bpcl|bharat petroleum( corporation( ltd\.?)?)?)$"),
    ("Indian Railways", r"^(indian railways?|northern railway|southern railway|central railway|western railway)$"),
    ("Bangalore Metro (BMRCL)", r"^bmrcl$|bangalore metro"),
    ("Government", r"^(govt\.?|government)$"),
    ("Mehsana Municipality", r"^mehsana\s+mun\w*\b"),
]
OPERATOR_JUNK = re.compile(r"^(private|public|toilet|public toilet|free toilet|yes|no|unknown|none|n/?a|-|male|female|gents?|ladies|men|women|unisex|sarvajanik)$", re.I)
# values that describe the toilet or its price rather than who runs it
OPERATOR_NOT_AN_OPERATOR = re.compile(r"\d+\s*(rs\.?|rupees?|inr|/-)|₹|\brs\.?\s*\d|toilet|washroom|urinal|locker|\bc\.?r\.?\b|pay\s*(&|and)?\s*use|\bfree\b", re.I)
_OP_NOISE = re.compile(r"\d+\s*(rs\.?|rupees?|inr|/-)|₹\s*\d+|\brs\.?\s*\d+|\b(public|paid|pay|free|deluxe|use|toilets?|washrooms?|urinals?|lockers?|c\.?r\.?|and|shower|bath|block|per|person|near|nr)\b\.?|[()&,/+-]", re.I)
# what's left after removing noise is only an operator if it names an organisation, not a place type or a word like 'male'
_OP_NOT_A_NAME = re.compile(r"^(male|female|gents?|ladies|men|women|unisex|sarvajanik|swachh|swachh bharat|public|petrol pump|bus stand|isbt|"
                            r"railway station|market|park|temple|hospital|school|college|mall|sector \w+|ward \w+|\w{1,3})$", re.I)


def _looks_like_description(raw):
    """A sentence typed into Operator ('Kalaignar Centenary Library was inaugurated by…')."""
    words = raw.split()
    return len(words) > 7 or '"' in raw or re.search(r"\b(was|were|is|are|featuring|inaugurated|located|offers?)\b", raw, re.I)


def operator_fee_hint(raw):
    """'5 Rs per use' typed into Operator -> ('paid', (5, 5)); 'Pay & use' -> ('paid', None); 'Free' -> ('free', None)."""
    if not raw:
        return None
    low = raw.lower()
    if re.search(r"\bfree\b", low):
        return ("free", None)
    price = parse_price(raw) if re.search(r"\d", low) and re.search(r"rs|rupee|inr|₹|/-", low) else None
    if price or re.search(r"pay\s*(&|and)?\s*use", low):
        return ("paid", price)
    return None


def canonical_operators(values):
    """Map every raw operator spelling to a canonical form. Returns {raw: canonical or None}."""
    mapping = {}
    rest = Counter()
    for raw, n in values.items():
        low = raw.lower().strip(" .")
        if OPERATOR_JUNK.match(low) or re.search(r"\bvisitors?\s+cent(er|re)\b", low) or _looks_like_description(raw):
            mapping[raw] = None
            continue
        for canon, pat in OPERATOR_RULES:  # known organisations first, even if the text also mentions "toilet"
            if re.search(pat, low):
                mapping[raw] = canon
                break
        else:
            if OPERATOR_NOT_AN_OPERATOR.search(low):
                # "Goa Tourism Toilet" -> "Goa Tourism"; "5 Rs per use" -> nothing left -> not an operator
                left = re.sub(r"\s+", " ", _OP_NOISE.sub(" ", raw)).strip(" .-")
                low_left = left.lower()
                canon = next((c for c, pat in OPERATOR_RULES if re.search(pat, low_left)), None)
                if canon:
                    mapping[raw] = canon  # "SBM Toilet" -> Swachh Bharat Mission
                elif (len(re.sub(r"[^A-Za-z\u0900-\u0dff]", "", left)) >= 4 and not OPERATOR_JUNK.match(low_left)
                      and not _OP_NOT_A_NAME.match(low_left)
                      and re.search(r"\b(?:(?i:municipal\w*|muncip\w*|corporation|council|panchayat\w*|nagar|tourism|department|dept|board|"
                                    r"authority|trust|foundation|society|club|ltd|limited|pvt|company|railways?|metro|government|govt|"
                                    r"university|institute|hospital|temple|church|mosque|gurudwara|bank|petroleum|oil)|[A-Z]{3,})\b", left)):
                    rest[left] += n
                    mapping[raw] = ("__left__", left)
                else:
                    mapping[raw] = None
                continue
            rest[raw] = n
    # cluster the remaining spellings: most frequent spelling becomes the canonical one
    canon_list = []
    resolved = {}
    for raw, _ in sorted(rest.items(), key=lambda x: (-x[1], x[0])):
        hit = process.extractOne(raw.lower(), [c.lower() for c in canon_list], scorer=fuzz.token_sort_ratio, score_cutoff=92) if canon_list else None
        if hit:
            resolved[raw] = canon_list[hit[2]]
        else:
            canon_list.append(tidy_case(raw))
            resolved[raw] = tidy_case(raw)
    for raw in list(mapping):
        if isinstance(mapping[raw], tuple):
            mapping[raw] = resolved[mapping[raw][1]]
    for raw in rest:
        mapping.setdefault(raw, resolved[raw])
    return mapping


# ---------------------------------------------------------------- cities, addresses, PIN codes

CITY_ALIASES = {
    "bangalore": "Bengaluru", "bengaluru": "Bengaluru", "gurgaon": "Gurugram", "panjim": "Panaji", "calcutta": "Kolkata",
    "bombay": "Mumbai", "madras": "Chennai", "trivandrum": "Thiruvananthapuram", "cochin": "Kochi", "poona": "Pune",
    "mysore": "Mysuru", "pondicherry": "Puducherry", "pondy": "Puducherry", "baroda": "Vadodara", "allahabad": "Prayagraj",
    "saltlake city": "Salt Lake City", "salt lake": "Salt Lake City", "sahibzada ajit singh nagar": "Mohali",
    "benares": "Varanasi", "banaras": "Varanasi", "vizag": "Visakhapatnam", "hoshangabad": "Narmadapuram",
    "മുവാറ്റുപുഴ": "Muvattupuzha", "darjeeeling": "Darjeeling",
}
STATE_WORDS = None  # filled by build_data with state names


def canonical_city(raw, state, district_names, state_names):
    """-> (city or None, leftover text that looks like an address or None)."""
    if not raw:
        return None, None
    if len(raw) > 40 or re.search(r"\b(beside|opp\.?|near|road|nagar,|dt\.?)\b", raw, re.I) and "," in raw:
        return None, raw  # an address typed into the city field
    parts = [p.strip() for p in re.split(r",", raw) if p.strip()]
    parts = [re.sub(r"\(.*?\)", "", p).strip() for p in parts]
    parts = [p for p in parts if p and p.lower() not in ("india",) and p.lower() not in state_names and not re.match(r"^dist\.?\b", p, re.I)]
    if not parts:
        return None, None
    choice = None
    for p in parts:  # prefer a part that is a known city alias or a district of this state
        if p.lower() in CITY_ALIASES or process.extractOne(p, district_names, scorer=fuzz.ratio, score_cutoff=90):
            choice = p
    choice = choice or parts[0]
    c = CITY_ALIASES.get(choice.lower(), choice)
    hit = process.extractOne(c, district_names, scorer=fuzz.ratio, score_cutoff=90) if district_names else None
    if hit:
        c = hit[0]
    return tidy_case(c), None


# India Post: first digit of the PIN code = postal zone
PIN_ZONE_STATES = {
    "1": {"Delhi (NCT)", "Haryana", "Punjab", "Chandigarh", "Himachal Pradesh", "Jammu and Kashmir", "Ladakh"},
    "2": {"Uttar Pradesh", "Uttarakhand"},
    "3": {"Rajasthan", "Gujarat", "Dadra and Nagar Haveli and Daman and Diu"},
    "4": {"Maharashtra", "Goa", "Madhya Pradesh", "Chhattisgarh"},
    "5": {"Telangana", "Andhra Pradesh", "Karnataka", "Puducherry"},
    "6": {"Tamil Nadu", "Kerala", "Puducherry", "Lakshadweep"},
    "7": {"West Bengal", "Sikkim", "Andaman and Nicobar Islands", "Odisha", "Assam", "Arunachal Pradesh", "Meghalaya",
          "Manipur", "Mizoram", "Nagaland", "Tripura"},
    "8": {"Bihar", "Jharkhand"},
}
PIN_RE = re.compile(r"(?<!\d)([1-8]\d{2})\s?(\d{3})(?!\d)")


def find_pin(text):
    m = PIN_RE.search(text or "")
    return m.group(1) + m.group(2) if m else None


def valid_pin(pin, state):
    return bool(pin and re.fullmatch(r"[1-8]\d{5}", pin) and state in PIN_ZONE_STATES.get(pin[0], set()))


def clean_address(raw, pin, city, district, state):
    if not raw:
        return None
    raw = raw.strip(" ,.-–—")
    a = re.sub(r"\s*,\s*(,\s*)+", ", ", raw)
    a = re.sub(r"\s*,\s*", ", ", a).strip(" ,.-")
    if pin:
        a = re.sub(rf"[\s,-]*{pin[:3]}\s?{pin[3:]}\b", "", a).strip(" ,.-")
    # drop trailing country / state / repeated city at the end
    for tail in ("india", (state or "").lower()):
        if tail and a.lower().endswith(tail):
            a = a[: -len(tail)].strip(" ,.-")
    a = a.strip(" ,.-–—")
    # drop 1–2 character fragments ("9, H") unless they are a house number in front of a street
    parts = [p.strip() for p in a.split(",")]
    keep = [p for i, p in enumerate(parts) if len(re.sub(r"[^0-9A-Za-z\u0900-\u0dff]", "", p)) > 2
            or (p.isdigit() and i + 1 < len(parts) and len(parts[i + 1]) > 2)]
    a = ", ".join(keep)
    if not a or a.isdigit() or len(a) < 3 or not re.search(r"[A-Za-z\u0900-\u0dff]", a):
        return None
    if a.lower() in CITY_ALIASES or a.lower() in {"india"}:
        return None  # the address is just a (former) city name
    if a.lower() in {(city or "").lower(), (district or "").lower(), (state or "").lower()}:
        return None
    return a


# ---------------------------------------------------------------- phone / web / price

def clean_phones(raw):
    """-> (list of '+91 98765 43210' style numbers, number of discarded fragments)."""
    if not raw:
        return [], 0
    out, bad = [], 0
    for part in re.split(r"[;,/]|\bor\b", raw):
        part = re.sub(r"^\+\s*0", "0", part.strip())  # '+0xxxxxxxxxx' is a domestic number with a stray '+'
        if not part:
            continue
        try:
            num = phonenumbers.parse(part, "IN")
            if phonenumbers.is_valid_number(num):
                f = phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.INTERNATIONAL)
                if f not in out:
                    out.append(f)
                continue
        except phonenumbers.NumberParseException:
            pass
        bad += 1
    return out, bad


def clean_website(raw):
    if not raw:
        return None
    url = raw.split(";")[0].strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        p = urlsplit(url)
    except ValueError:
        return None
    host = (p.hostname or "").lower()
    if not host or "." not in host or not re.fullmatch(r"[a-z0-9.-]+", host) or re.search(r"[\s\"'<>]", url):
        return None
    netloc = host + (f":{p.port}" if p.port else "")
    return urlunsplit((p.scheme.lower(), netloc, p.path or "/", p.query, ""))


def parse_price(raw):
    """-> (min, max) in rupees, or None if not a plausible toilet charge."""
    if not raw:
        return None
    s = raw.lower().replace(",", "")
    if s.strip() in ("0", "zero", "free"):
        return (0, 0)
    if re.search(r"\d\s*k\b", s):
        return None
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", s)]
    if not nums:
        return None
    lo, hi = min(nums), max(nums)
    if hi > 100:  # not a plausible charge for using a toilet (e.g. a camp-site or resort fee)
        return None
    return (int(lo) if lo.is_integer() else lo, int(hi) if hi.is_integer() else hi)


def fmt_price(p):
    if not p:
        return None
    lo, hi = p
    return f"₹{lo}" if lo == hi else f"₹{lo}–{hi}"


# ---------------------------------------------------------------- categories

CATEGORY_GROUPS = [
    ("Public toilet", r"^public toilet$"),
    ("Food & drink", r"restaurant|cafe|fast food|food court|bar$|pub$|ice cream|shop \((bakery|pastry|coffee|tea)\)"),
    ("Fuel & highway", r"petrol|highway|fuel"),
    ("Transport", r"bus station|railway|airport|platform|parking|waiting room|\(bus station\)"),
    ("Shopping", r"mall|shop|supermarket|department store|market|convenience|\(retail\)"),
    ("Tourism & leisure", r"museum|park|attraction|camp|cinema|theatre|hotel|motel|chalet|resort|gallery|stadium|sports|leisure|tourism|club"),
    ("Education & childcare", r"school|childcare|college|university|library|educational"),
    ("Health", r"clinic|hospital|medical|chemist"),
    ("Government & civic", r"government|police|courthouse|community centre|social|office|ngo|bank|conference|reception"),
    ("Religious", r"worship"),
]


def category_group(c):
    low = (c or "").lower()
    for g, pat in CATEGORY_GROUPS:
        if re.search(pat, low):
            return g
    return "Other places"


# ---------------------------------------------------------------- de-duplication

DETAIL_KEYS = ["fee", "pr", "oh", "sc", "sca", "acc", "accl", "wc", "g", "bc", "ts", "hw", "hws", "soap", "tp", "dw", "sh", "disp", "ph", "web"]


def _gender_caps(g):
    return {"separate": {"w", "m"}, "women": {"w"}, "men": {"m"}, "unisex": {"u"}}.get(g, set())


def _merge_gender(gs):
    caps = set().union(*[_gender_caps(g) for g in gs if g])
    if not caps:
        return None
    if {"w", "m"} <= caps:
        return "separate"
    if "u" in caps:
        return "unisex"
    return "women" if "w" in caps else "men"


_NEUTRAL_GENERIC = {"Public toilet", "Men's toilet", "Women's toilet"}


def compatible(a, b, dist_m):
    """Could records a and b be the same toilet? Conservative: any conflicting fact keeps them apart."""
    if a["s"] != b["s"]:
        return False
    if not a["s"] and a["c"] != b["c"]:
        return False
    if a.get("fee") and b.get("fee") and a["fee"] != b["fee"]:
        return False
    if a.get("op") and b.get("op") and a["op"] != b["op"]:
        return False
    if a.get("accl") and b.get("accl") and a["accl"] != b["accl"]:
        return False  # e.g. one point is public, the other needs a key; "Staff only" vs "Students only"
    if a.get("sc") and b.get("sc") and a["sc"] != b["sc"]:
        return False  # different opening hours: keep both rather than publish one point's hours
    ma, mb = a.get("_gm"), b.get("_gm")  # gender as originally mapped (kept even for stale records)
    if {ma, mb} == {"men", "women"} and a.get("v", 1) != b.get("v", 1):
        return False  # don't fold an old women's point into a current men's-only record (or vice versa)
    na, nb = a["n"].lower(), b["n"].lower()
    # "Colony-3" vs "Colony-4", "T-I" vs "T-III": different numbers mean different places
    nums = lambda s: set(re.findall(r"\d+|\b(?:i{1,3}|iv|v|vi{0,3}|ix|x)\b", s))  # noqa: E731
    if nums(na) != nums(nb):
        return False
    ga, gb = a.get("gen"), b.get("gen")
    if ga and gb:
        # same kind of generic toilet (or a plain 'Public toilet' / men's / women's point of a block)
        same_kind = a["n"] == b["n"] or a["n"] in _NEUTRAL_GENERIC and b["n"] in _NEUTRAL_GENERIC
        return same_kind and (a["s"] == 1 or dist_m <= 2)
    if ga or gb:
        # a generic point next to a named one: only if the name is a variant of it ("GVMC Public toilet")
        g, sp = (na, nb) if ga else (nb, na)
        return dist_m <= 15 and fuzz.token_set_ratio(g, sp) >= 90
    return fuzz.token_set_ratio(na, nb) >= 90


_RANK = {"yes": 3, "limited": 2, "no": 1}


def _best(values):
    vals = [v for v in values if v]
    return max(vals, key=lambda v: _RANK.get(v, 0)) if vals else None


def _id_key(i):
    m = re.match(r"^OSM-([NWR])(\d+)$", i)
    return ("NWR".index(m.group(1)), int(m.group(2))) if m else (9, 0)


def dedupe(items, radius_m=20.0):
    """Seed-anchored spatial grouping: every member is within radius_m of the group's seed (no chaining)."""
    if not items:
        return items, []
    X = np.radians([[i["la"], i["lo"]] for i in items])
    tree = BallTree(X, metric="haversine")
    neigh, dists = tree.query_radius(X, r=radius_m / EARTH_M, return_distance=True)
    # seeds: most detailed first, then most recently edited, then by id (deterministic)
    def seed_key(k):
        ed = (items[k].get("ed") or "0000-00-00").replace("-", "")
        return (-items[k]["q"], -int(ed), items[k]["id"])
    order = sorted(range(len(items)), key=seed_key)
    taken = [False] * len(items)
    groups = []
    for k in order:
        if taken[k]:
            continue
        taken[k] = True
        group = [k]
        for j, dr in sorted(zip(neigh[k], dists[k]), key=lambda x: x[1]):
            if taken[j] or j == k:
                continue
            dm = dr * EARTH_M
            if compatible(items[k], items[j], dm) and all(compatible(items[m], items[j], dm) or m == k for m in group):
                taken[j] = True
                group.append(j)
        groups.append(group)

    out, merged_groups = [], []
    for g in groups:
        if len(g) == 1:
            out.append(items[g[0]])
            continue
        members = [items[k] for k in g]
        seed = dict(members[0])
        by_recent = sorted(members, key=lambda r: r.get("ed") or "", reverse=True)
        for key in DETAIL_KEYS + ["op", "a", "pin", "city", "nl"]:
            if key == "g":
                continue
            if seed.get(key) in (None, "", []):
                for r in by_recent:
                    if r.get(key) not in (None, "", []):
                        seed[key] = r[key]
                        if key == "sc":
                            seed["oh"], seed["sca"] = r.get("oh"), r.get("sca")
                        break
        g_all = _merge_gender([r.get("g") for r in members])
        if g_all:
            seed["g"] = g_all
        # a block is as accessible / equipped as its best stall
        for key in ("wc", "bc", "hw", "tp", "dw", "sh", "soap"):
            b = _best([r.get(key) for r in members])
            if b:
                seed[key] = b
        flags = set("".join(r.get("ts") or "" for r in members))
        if flags:
            seed["ts"] = "".join(f for f in "IWU" if f in flags)
        caps = set().union(*[_gender_caps(r.get("_gm")) for r in members])
        if seed.get("n") in ("Men's toilet", "Women's toilet") and ({"w", "m"} <= caps or "u" in caps or seed.get("g") in ("separate", "unisex")):
            seed["n"] = "Public toilet"  # the merged block serves more than one gender
        if seed.get("gen"):
            specific = [r for r in members if not r.get("gen")]
            if specific:
                seed["n"], seed["gen"] = specific[0]["n"], 0
        seed["ed"] = max((r.get("ed") or "") for r in members) or None
        seed["v"] = 1 if any(r.get("v", 1) for r in members) else 0
        # stable id: the lowest OSM id in the group, so it doesn't change when details change between builds
        ids = sorted((r["id"] for r in members), key=_id_key)
        seed["id"] = ids[0]
        seed["ids"] = ids
        names = {r.get("aka") or r["n"] for r in members} | {x for r in members for x in (r.get("alt") or [])}
        seed["alt"] = sorted(names - {seed["n"]}) or None
        out.append(seed)
        merged_groups.append(seed["ids"])
    return out, merged_groups


# ---------------------------------------------------------------- staleness

def years_before(ref, years):
    """The same calendar day `years` earlier (29 Feb -> 28 Feb)."""
    try:
        return ref.replace(year=ref.year - years)
    except ValueError:
        return ref.replace(year=ref.year - years, day=28)


def to_date(s):
    try:
        y, m, d = (int(x) for x in s[:10].split("-"))
        return date(y, m, d)
    except (ValueError, AttributeError):
        return None
