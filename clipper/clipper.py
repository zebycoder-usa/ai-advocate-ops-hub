#!/usr/bin/env python3
"""Islamic Content Clipper - turns one long lecture video into short vertical
captioned clips ready to upload to TikTok, YouTube Shorts, Instagram Reels.

Pipeline stages (each resumable, output cached in the project folder):
  1. download    - yt-dlp fetches the source video
  2. transcribe  - faster-whisper produces word-level timestamps
  3. select      - Claude reads the transcript and picks the best clip moments
  4. cut         - ffmpeg crops to 9:16, burns styled captions, exports clips
  5. package     - writes captions.txt with title/description/hashtags per clip

Usage:
  python clipper.py "https://youtube.com/watch?v=XXXX"
  python clipper.py "https://..." --clips 10 --out ./output
  python clipper.py "https://..." --channel tech      # itech.cuts profile
  python clipper.py --resume ./output/VIDEO_ID        # re-run remaining stages

Requires: ffmpeg on PATH, pip install -r requirements.txt,
and CLAUDE_API_KEY (or ANTHROPIC_API_KEY) in the environment for the select stage.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5")

SELECT_SYSTEM = """You are a clip editor for an Islamic content channel. You receive the \
timestamped transcript of a lecture and select the best short-form clips.

Rules, in priority order:
1. RESPECT THE CONTENT. Never cut in the middle of a Quranic ayah, a hadith, or a \
sentence in a way that changes or truncates its meaning. A clip must contain the \
complete thought, including the full ayah or hadith if one is being quoted, and any \
essential context so nothing is misleading out of context.
2. Each clip is 30 to 90 seconds, a self-contained moment: a story, one question \
answered, one reminder, an emotional or powerful point.
3. Start the clip at a hook, the strongest possible first sentence. End on a complete, \
satisfying closing sentence.
4. Titles are hooks in plain spoken English, no clickbait lies, no em dashes. \
Transliterate Arabic terms normally (dua, sabr, tawakkul).
5. Only use words actually spoken in the transcript. Never invent quotes or claims.

Output ONLY a JSON array, no prose, no markdown fences. Each element:
{"start": <seconds float>, "end": <seconds float>, "title": "<hook title, under 60 chars>",
 "description": "<1-2 sentence description>", "hashtags": "<8-12 space-separated hashtags>",
 "why": "<one line: why this moment works>"}
Snap start/end to the segment boundaries given in the transcript. Order by strongest first."""

TECH_SELECT_SYSTEM = """You are a clip editor for itech.cuts, a short-form tech news channel. You \
receive the timestamped transcript of a tech video (product launch, keynote, review, \
demo) and select the best short-form clips.

Rules, in priority order:
1. ACCURACY. Only use words actually spoken in the transcript. Never invent specs, \
prices, dates, or quotes. A clip must contain the complete claim and any caveat the \
speaker attaches to it so nothing is misleading out of context.
2. Each clip is 15 to 60 seconds, a self-contained moment: one announcement, one \
demo, one surprising number, one strong opinion.
3. Start the clip on the hook, the single most attention-grabbing sentence. End on a \
complete closing sentence.
4. Titles are hooks in plain spoken English, under 60 characters, no clickbait lies, \
no em dashes, no en dashes. Name the product and company.
5. Hashtags: 8 to 12, mix the product, company, and broad tech tags (#TechNews \
#AI #EV etc). Always include #itechcuts.

Output ONLY a JSON array, no prose, no markdown fences. Each element:
{"start": <seconds float>, "end": <seconds float>, "title": "<hook title, under 60 chars>",
 "description": "<1-2 sentence description>", "hashtags": "<8-12 space-separated hashtags>",
 "why": "<one line: why this moment works>"}
Snap start/end to the segment boundaries given in the transcript. Order by strongest first."""

CHANNELS = {
    "islamic": SELECT_SYSTEM,   # Sadiqa's channel, Raised, Last Third
    "tech": TECH_SELECT_SYSTEM, # itech.cuts
}


def run(cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd))
    return subprocess.run(cmd, check=True, **kw)


def stage_download(url, proj):
    video = proj / "source.mp4"
    if video.exists():
        print("[download] cached, skipping")
        return video
    print("[download] fetching video...")
    run(["yt-dlp", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
         "--merge-output-format", "mp4", "-o", str(video), url])
    return video


def stage_transcribe(video, proj):
    tpath = proj / "transcript.json"
    if tpath.exists():
        print("[transcribe] cached, skipping")
        return json.loads(tpath.read_text())
    print("[transcribe] running whisper (this can take a while)...")
    from faster_whisper import WhisperModel
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"),
                         device="auto", compute_type="auto")
    segments, info = model.transcribe(str(video), word_timestamps=True, vad_filter=True)
    data = {"language": info.language, "segments": []}
    for seg in segments:
        data["segments"].append({
            "start": round(seg.start, 2), "end": round(seg.end, 2),
            "text": seg.text.strip(),
            "words": [{"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word}
                      for w in (seg.words or [])],
        })
        print(f"  [{seg.start:7.1f}s] {seg.text.strip()[:80]}")
    tpath.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    return data


def parse_clips_json(text):
    text = text.strip()
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if not m:
        raise ValueError("no JSON array found in model output")
    return json.loads(m.group(0))


def stage_select(transcript, proj, n_clips, channel="islamic"):
    spath = proj / "clips.json"
    if spath.exists():
        print("[select] cached, skipping (delete clips.json to re-select)")
        return json.loads(spath.read_text())
    print(f"[select] asking Claude ({MODEL}) to pick the best {n_clips} clips...")
    import anthropic
    api_key = os.environ.get("CLAUDE_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    lines = [f"[{s['start']:.1f} - {s['end']:.1f}] {s['text']}"
             for s in transcript["segments"]]
    prompt = (f"Transcript below. Select the {n_clips} best clips per your rules.\n\n"
              + "\n".join(lines))

    with client.messages.stream(
        model=MODEL,
        max_tokens=16000,
        system=CHANNELS[channel],
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        response = stream.get_final_message()

    if response.stop_reason == "refusal":
        raise RuntimeError("model declined the request: "
                           f"{getattr(response.stop_details, 'explanation', '')}")
    text = "".join(b.text for b in response.content if b.type == "text")
    clips = parse_clips_json(text)

    dur_ok = []
    for c in clips:
        length = float(c["end"]) - float(c["start"])
        if 15 <= length <= 120:
            dur_ok.append(c)
        else:
            print(f"  ! dropping clip '{c.get('title', '?')}' - bad length {length:.0f}s")
    spath.write_text(json.dumps(dur_ok, ensure_ascii=False, indent=1))
    print(f"[select] {len(dur_ok)} clips chosen")
    return dur_ok


def ass_time(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,320,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect
"""


def build_ass(transcript, start, end, path, words_per_line=4):
    """Burned-caption subtitle file for one clip, timed from whisper words."""
    words = []
    for seg in transcript["segments"]:
        if seg["end"] < start or seg["start"] > end:
            continue
        if seg["words"]:
            words += [w for w in seg["words"] if start <= w["start"] < end]
        else:
            words.append({"start": max(seg["start"], start),
                          "end": min(seg["end"], end), "word": " " + seg["text"]})
    lines = [ASS_HEADER]
    for i in range(0, len(words), words_per_line):
        group = words[i:i + words_per_line]
        text = "".join(w["word"] for w in group).strip().replace("\n", " ")
        t0 = max(group[0]["start"] - start, 0)
        t1 = max(group[-1]["end"] - start, t0 + 0.3)
        lines.append(f"Dialogue: 0,{ass_time(t0)},{ass_time(t1)},Cap,,0,0,0,,{text}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def stage_cut(video, transcript, clips, proj):
    outdir = proj / "clips"
    outdir.mkdir(exist_ok=True)
    made = []
    for i, c in enumerate(clips, 1):
        out = outdir / f"clip_{i:02d}.mp4"
        made.append(out)
        if out.exists():
            print(f"[cut] {out.name} cached, skipping")
            continue
        print(f"[cut] {out.name}: {c['title']}")
        ass = outdir / f"clip_{i:02d}.ass"
        build_ass(transcript, float(c["start"]), float(c["end"]), ass)
        ass_arg = str(ass).replace("\\", "/").replace(":", "\\:")
        vf = ("crop=ih*9/16:ih,scale=1080:1920,"
              f"subtitles='{ass_arg}'")
        run(["ffmpeg", "-y", "-ss", str(c["start"]), "-to", str(c["end"]),
             "-i", str(video), "-vf", vf,
             "-c:v", "libx264", "-preset", "fast", "-crf", "20",
             "-c:a", "aac", "-b:a", "128k", str(out)])
    return made


def stage_package(clips, proj):
    lines = []
    for i, c in enumerate(clips, 1):
        lines += [f"=== clip_{i:02d}.mp4 ===",
                  f"TITLE: {c['title']}",
                  f"DESCRIPTION: {c['description']}",
                  f"HASHTAGS: {c['hashtags']}",
                  f"WHY: {c.get('why', '')}",
                  f"TIME: {c['start']} - {c['end']}", ""]
    (proj / "captions.txt").write_text("\n".join(lines), encoding="utf-8")
    print(f"[package] wrote {proj / 'captions.txt'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", nargs="?", help="YouTube (or other) video URL")
    ap.add_argument("--clips", type=int, default=10, help="clips to extract (default 10)")
    ap.add_argument("--out", default="./output", help="output root folder")
    ap.add_argument("--resume", help="existing project folder to resume")
    ap.add_argument("--channel", choices=sorted(CHANNELS), default="islamic",
                    help="clip-selection profile: islamic (default) or tech (itech.cuts)")
    args = ap.parse_args()

    if args.resume:
        proj = Path(args.resume)
        url = (proj / "url.txt").read_text().strip() if (proj / "url.txt").exists() else None
    elif args.url:
        vid = re.sub(r"[^A-Za-z0-9_-]", "", args.url.split("v=")[-1].split("/")[-1])[:24]
        proj = Path(args.out) / (vid or "video")
        proj.mkdir(parents=True, exist_ok=True)
        (proj / "url.txt").write_text(args.url)
        url = args.url
    else:
        ap.error("give a URL or --resume <folder>")

    print(f"Project folder: {proj}")
    video = stage_download(url, proj) if url else proj / "source.mp4"
    transcript = stage_transcribe(video, proj)
    clips = stage_select(transcript, proj, args.clips, args.channel)
    stage_cut(video, transcript, clips, proj)
    stage_package(clips, proj)
    print(f"\nDone. Review the clips in {proj / 'clips'} and post using {proj / 'captions.txt'}")


if __name__ == "__main__":
    main()
