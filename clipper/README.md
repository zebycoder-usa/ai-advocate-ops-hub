# Islamic Content Clipper

Turns one long lecture video into 10 short vertical captioned clips, ready to
upload to TikTok, YouTube Shorts, Instagram Reels, and Facebook Reels.

One command replaces OpusClip: download, transcribe (Whisper), pick the best
moments (Claude, with rules that never cut mid-ayah or mid-hadith), crop to
9:16, burn big captions, and write ready-to-paste titles/hashtags per clip.

## One-time setup (worker's PC)

1. Install Python 3.10+ and [ffmpeg](https://ffmpeg.org/download.html)
   (on Windows: `winget install ffmpeg`, then reopen the terminal).
2. In this folder run: `pip install -r requirements.txt`
3. Set the API key (ask Saqib or Zeb for it):
   - Windows: `setx CLAUDE_API_KEY "sk-ant-..."` then reopen the terminal.
   - Mac/Linux: add `export CLAUDE_API_KEY="sk-ant-..."` to your shell profile.

Optional environment variables:
- `CLAUDE_MODEL` - defaults to `claude-opus-5`
- `WHISPER_MODEL` - defaults to `small` (use `medium` for better accuracy if
  the PC can handle it, `base` for speed on a weak laptop)

## Daily use

```
python clipper.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

Output lands in `./output/VIDEO_ID/`:
- `clips/clip_01.mp4 ... clip_10.mp4` - vertical, captioned, ready to upload
- `captions.txt` - title, description, and hashtags for each clip

Each stage caches its result, so if anything fails, rerun the same command (or
`python clipper.py --resume ./output/VIDEO_ID`) and it continues where it left
off. To get a fresh clip selection, delete `clips.json` in the project folder
and rerun.

Useful flags: `--clips 12` (how many clips), `--out D:/clips` (output root).

## Worker daily routine

1. Run the command on the day's source video (only use videos we have
   permission to clip, or Sadiqa's own recordings).
2. WATCH every clip before posting. Reject any clip that cuts an ayah, hadith,
   or sentence short, misrepresents the speaker, or has the face badly framed.
3. Copy title/description/hashtags from `captions.txt`, adjust if needed.
4. Upload or schedule ~10 clips across TikTok / Shorts / Reels.
5. Log the day in the tracking sheet: date, source video, clips posted, views.

The review step is not optional. The tool is good but the human is responsible
for what gets posted.
