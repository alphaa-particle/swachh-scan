"""OpenStreetMap opening_hours -> weekly schedule (used by build_data.py)."""
import re

# ---------------------------------------------------------------- opening hours
# A pragmatic parser for the OSM opening_hours values found in this file.
# Output: "24/7", or a list of 7 day-lists (Mon..Sun) of [startMinute, endMinute].
# Rules with month/date/nth-week selectors are skipped and the result flagged approximate.

DAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"]
DAY_ALIASES = {"sun": "su", "wed": "we", "mon": "mo", "tue": "tu", "thu": "th", "fri": "fr", "sat": "sa"}
MONTHS = r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b"


def _minutes(t):
    m = re.fullmatch(r"(\d{1,2})[:.](\d{2})", t)
    if not m:
        m2 = re.fullmatch(r"(\d{1,2})", t)
        if not m2:
            return None
        return int(m2.group(1)) * 60
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 24 or mi > 59:
        return None
    return h * 60 + mi


def _ampm(text):
    """'12 Noon - 2 AM' -> '12:00-02:00'."""
    def conv(m):
        h = int(m.group(1))
        mi = m.group(2) or "00"
        suf = m.group(3).lower()
        if suf == "pm" and h < 12:
            h += 12
        if suf == "am" and h == 12:
            h = 0
        return f"{h:02d}:{mi}"
    return re.sub(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|noon)", conv, text, flags=re.I)


def _parse_days(sel):
    """'Mo-Fr,Su' -> set of day indexes. Returns None if the selector isn't understood."""
    days = set()
    for part in sel.split(","):
        part = part.strip()
        if not part or part == "ph":
            continue
        m = re.fullmatch(r"([a-z]{2})(?:-([a-z]{2}))?", part)
        if not m or m.group(1) not in DAYS or (m.group(2) and m.group(2) not in DAYS):
            return None
        a = DAYS.index(m.group(1))
        b = DAYS.index(m.group(2)) if m.group(2) else a
        i = a
        while True:  # handles wrap-around ranges like We-Mo
            days.add(i)
            if i == b:
                break
            i = (i + 1) % 7
    return days


def parse_hours(raw):
    """Returns (schedule, approximate, open_ends) or (None, False, []) if not understood.

    open_ends lists [day, end_minute] for intervals whose closing time is open-ended in OSM ("18:00+"),
    so the app can say "closing time not mapped" instead of claiming a definite close.
    """
    if not raw:
        return None, False, []
    text = raw.strip()
    text = re.sub(r'"[^"]*"', "", text).strip()  # drop comments
    low = _ampm(text).lower()
    for k, v in DAY_ALIASES.items():
        low = re.sub(rf"\b{k}\b", v, low)
    low = re.sub(r"\s*-\s*", "-", low)
    if low in ("24/7", "24 hours", "24x7"):
        return "24/7", False, []
    if not low or low.startswith("unknown"):
        return None, False, []

    week = [[] for _ in range(7)]
    open_end_at = [set() for _ in range(7)]  # end minutes that are open-ended, per day
    approx = False
    understood = False

    # split into rules: ';' = override rule, ',' before a weekday (after a time/off) = additive rule
    parts = []
    for chunk in [c.strip() for c in low.split(";")]:
        if not chunk:
            continue
        sub = re.split(r"(?:(?<=[\d+])|(?<=off)|(?<=closed)),\s*(?=(?:mo|tu|we|th|fr|sa|su|ph)\b)", chunk)
        for j, s in enumerate(sub):
            parts.append((s.strip(), j > 0))

    for rule, additive in parts:
        if re.search(MONTHS, rule) or "[" in rule:
            approx = True
            continue
        if rule == "24/7":
            week = [[[0, 1440]] for _ in range(7)]
            open_end_at = [set() for _ in range(7)]
            understood = True
            continue
        m = re.match(r"^((?:(?:mo|tu|we|th|fr|sa|su|ph)\b(?:-(?:mo|tu|we|th|fr|sa|su)\b)?\s*,?\s*)+)?(.*)$", rule)
        sel, body = (m.group(1) or "").replace(" ", "").strip(","), m.group(2).strip()
        if sel == "ph" or (sel and _parse_days(sel) == set()):
            # public-holiday-only rule: we can't know the holiday calendar, so flag the schedule as approximate
            approx = True
            continue
        days = _parse_days(sel) if sel else set(range(7))
        if days is None:
            approx = True
            continue
        if "ph" in sel.split(",") and days != set(range(7)):
            approx = True  # e.g. "Su,PH off": the holiday part can't be shown
        if body in ("off", "closed"):
            if sel:  # a bare trailing "closed" with no days is a no-op
                for d in days:
                    week[d] = []
                    open_end_at[d] = set()
                understood = True
            continue
        if body in ("open", "unknown"):
            continue
        if body == "" and sel:
            body = "00:00-24:00"
        if body == "sunrise-sunset":
            body, approx = "06:00-18:30", True

        spans = []
        ok = True
        for span in [s.strip() for s in body.split(",") if s.strip()]:
            open_end = span.endswith("+")
            span = span.rstrip("+")
            if "-" not in span:
                if open_end and _minutes(span) is not None:
                    spans.append((_minutes(span), 1440, True))
                    approx = True
                    continue
                ok = False
                break
            a, b = span.split("-", 1)
            s, e = _minutes(a), _minutes(b)
            if s is None or e is None:
                ok = False
                break
            if open_end:
                approx = True
            spans.append((s, e, open_end))
        if not ok or not spans:
            approx = True
            continue

        if not additive:
            for d in days:
                week[d] = []
                open_end_at[d] = set()
        for d in days:
            for s, e, oe in spans:
                if oe and e > s:
                    open_end_at[d].add(e)
                if e == s:
                    week[d].append([0, 1440])
                    approx = True
                elif e > s:
                    week[d].append([s, e])
                else:  # past midnight
                    week[d].append([s, 1440])
                    if e > 0:
                        week[(d + 1) % 7].append([0, e])
        understood = True

    if not understood:
        return None, False, []

    # merge overlapping intervals per day
    merged = []
    for day in week:
        day = sorted(day)
        out = []
        for s, e in day:
            if out and s <= out[-1][1]:
                out[-1][1] = max(out[-1][1], e)
            else:
                out.append([s, e])
        merged.append(out)
    if all(d == [[0, 1440]] for d in merged):
        return "24/7", approx, []
    open_ends = [[d, e] for d in range(7) for _, e in merged[d] if e in open_end_at[d]]
    return merged, approx, open_ends
