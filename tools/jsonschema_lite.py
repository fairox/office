"""Just enough JSON Schema to check Tapir requests and responses (standard library only).

Supports type, properties, required, additionalProperties, items, enum, const, minItems, maxItems,
minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, pattern, $ref (to "#/Name"),
oneOf, anyOf, allOf. Returns a list of "path: problem" strings; empty means valid.
"""
import re

TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "null": lambda v: v is None,
}


def validate(value, schema, defs, path="$"):
    errors = []
    _check(value, schema, defs, path, errors)
    return errors


def _check(v, s, defs, path, errs):
    if s is None or s is True:
        return
    if "$ref" in s:
        _check(v, defs[s["$ref"].split("/")[-1]], defs, path, errs)
        rest = {k: x for k, x in s.items() if k not in ("$ref", "description")}
        if not rest:
            return
        s = rest
    t = s.get("type")
    if t is not None:
        kinds = t if isinstance(t, list) else [t]
        if not any(TYPES[k](v) for k in kinds):
            errs.append(f"{path}: expected {t}, got {type(v).__name__}")
            return
    if "enum" in s and v not in s["enum"]:
        errs.append(f"{path}: {v!r} not in {s['enum']}")
    if "const" in s and v != s["const"]:
        errs.append(f"{path}: {v!r} != {s['const']!r}")
    if TYPES["number"](v):
        if "minimum" in s and v < s["minimum"]:
            errs.append(f"{path}: {v} < minimum {s['minimum']}")
        if "maximum" in s and v > s["maximum"]:
            errs.append(f"{path}: {v} > maximum {s['maximum']}")
        if "exclusiveMinimum" in s and v <= s["exclusiveMinimum"]:
            errs.append(f"{path}: {v} <= exclusiveMinimum {s['exclusiveMinimum']}")
        if "exclusiveMaximum" in s and v >= s["exclusiveMaximum"]:
            errs.append(f"{path}: {v} >= exclusiveMaximum {s['exclusiveMaximum']}")
    if isinstance(v, str):
        if "minLength" in s and len(v) < s["minLength"]:
            errs.append(f"{path}: shorter than {s['minLength']}")
        if "pattern" in s and not re.search(s["pattern"], v):
            errs.append(f"{path}: does not match {s['pattern']}")
    if isinstance(v, list):
        if "minItems" in s and len(v) < s["minItems"]:
            errs.append(f"{path}: fewer than {s['minItems']} items")
        if "maxItems" in s and len(v) > s["maxItems"]:
            errs.append(f"{path}: more than {s['maxItems']} items")
        if "items" in s:
            for i, item in enumerate(v):
                _check(item, s["items"], defs, f"{path}[{i}]", errs)
    if isinstance(v, dict):
        props = s.get("properties", {})
        for k in s.get("required", []):
            if k not in v:
                errs.append(f"{path}: missing required {k!r}")
        extra = s.get("additionalProperties", True)
        for k, item in v.items():
            if k in props:
                _check(item, props[k], defs, f"{path}.{k}", errs)
            elif extra is False:
                errs.append(f"{path}: unexpected property {k!r}")
            elif isinstance(extra, dict):
                _check(item, extra, defs, f"{path}.{k}", errs)
    for sub in s.get("allOf", []):
        _check(v, sub, defs, path, errs)
    if "anyOf" in s and not any(not validate(v, sub, defs, path) for sub in s["anyOf"]):
        errs.append(f"{path}: matches none of anyOf")
    if "oneOf" in s:
        n = sum(1 for sub in s["oneOf"] if not validate(v, sub, defs, path))
        if n != 1:
            errs.append(f"{path}: matches {n} of oneOf (needs exactly 1)")
