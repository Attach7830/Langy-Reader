"""Match a recording to source text using unique phrase anchors and bounded gaps."""
from bisect import bisect_left, bisect_right
from difflib import SequenceMatcher
import math
import unicodedata


def normalized(text):
    decomposed = unicodedata.normalize("NFD", text.casefold())
    return "".join(char for char in decomposed if char.isalnum() or char == "\u0303")


def align_recording(words, heard):
    source_parts = [normalized(word) for word in words]
    source = "".join(source_parts)
    spoken = [word for word in heard if normalized(word["word"]) and math.isfinite(word["start"])
              and math.isfinite(word["end"]) and word["end"] > word["start"] >= 0]
    heard_parts = [normalized(word["word"]) for word in spoken]
    detected = "".join(heard_parts)
    offsets, position = [], 0
    for part in heard_parts:
        offsets.append(position)
        position += len(part)
    width = 16
    index = {}
    for position in range(0, max(0, len(source) - width + 1), 4):
        phrase = source[position:position + width]
        index[phrase] = position if phrase not in index else None
    candidates = []
    for position in range(max(0, len(detected) - width + 1)):
        source_position = index.get(detected[position:position + width])
        if source_position is not None:
            candidates.append((source_position, position))
    tails, tail_ids, previous = [], [], []
    for number, (source_position, _) in enumerate(candidates):
        slot = bisect_left(tails, source_position)
        previous.append(tail_ids[slot - 1] if slot else -1)
        if slot == len(tails):
            tails.append(source_position)
            tail_ids.append(number)
        else:
            tails[slot], tail_ids[slot] = source_position, number
    chosen = []
    number = tail_ids[-1] if tail_ids else -1
    while number >= 0:
        chosen.append(candidates[number])
        number = previous[number]
    blocks = []
    for left, right in reversed(chosen):
        if blocks and left <= blocks[-1][0] + blocks[-1][2] and left - blocks[-1][0] == right - blocks[-1][1]:
            blocks[-1][2] = left + width - blocks[-1][0]
        elif not blocks or left >= blocks[-1][0] + blocks[-1][2] and right >= blocks[-1][1] + blocks[-1][2]:
            blocks.append([left, right, width])
    mapping = [-1] * len(source)
    # Highly repetitive beginner texts may have no unique phrase anchors at all.
    # A complete exact match still has an unambiguous word order, even with an intro/outro.
    complete_match = detected.find(source) if source else -1
    if complete_match >= 0:
        blocks = [[0, complete_match, len(source)]]
    strong = sum(block[2] for block in blocks)
    for left, right, length in blocks:
        mapping[left:left + length] = range(right, right + length)
    boundaries = [[0, 0, 0], *blocks, [len(source), len(detected), 0]]
    for before, after in zip(boundaries, boundaries[1:]):
        left, right = before[0] + before[2], before[1] + before[2]
        if after[0] - left > 2000 or after[1] - right > 2000:
            continue
        for match in SequenceMatcher(None, source[left:after[0]], detected[right:after[1]], autojunk=False).get_matching_blocks():
            if match.size >= 8 and not blocks:
                strong += match.size
            mapping[left + match.a:left + match.a + match.size] = range(right + match.b, right + match.b + match.size)
    timings, source_position, last_end, matched = [], 0, 0, 0
    for part in source_parts:
        positions = mapping[source_position:source_position + len(part)]
        source_position += len(part)
        stamp = None
        if positions and positions[0] >= 0 and all(value == positions[0] + step for step, value in enumerate(positions)):
            first, last = bisect_right(offsets, positions[0]) - 1, bisect_right(offsets, positions[-1]) - 1
            a, b = spoken[first], spoken[last]
            start = a["start"] + (a["end"] - a["start"]) * (positions[0] - offsets[first]) / len(heard_parts[first])
            end = b["start"] + (b["end"] - b["start"]) * (positions[-1] - offsets[last] + 1) / len(heard_parts[last])
            estimated = positions[0] != offsets[first] or positions[-1] + 1 != offsets[last] + len(heard_parts[last])
            if start >= last_end - .03 and end > max(last_end, start):
                stamp = {"start": max(last_end, start), "end": end, "review": estimated,
                         **({"estimated": True} if estimated else {})}
                last_end = end
                matched += 1
        timings.append(stamp)
    speech_ratio = len({value for value in mapping if value >= 0}) / max(1, len(detected))
    return {"timings": timings, "matchedWords": matched, "totalWords": len(words),
            "matchedSpeechRatio": speech_ratio, "strongMatchCharacters": strong}
