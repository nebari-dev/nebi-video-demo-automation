#!/usr/bin/env python3
"""Generate narration audio clips for the demo video using Kokoro TTS."""

import json
import warnings
from pathlib import Path

import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore", message="dropout option adds dropout")
from kokoro import KPipeline

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "audio"
VOICE = "am_puck"

# Continuous YouTube-style voiceover. Each clip flows into the next
# with no silence between scenes. The narration drives the video pacing.
#
# Pronunciation guide:
#   Nebi      → "Nebee"
#   pixi.toml → "pixie dot toml"
#   OCI       → "O.C.I."
#   UV        → "U.V."
NARRATIONS = [
    # Scene order follows the UI tab order:
    # Login → Workspaces → Overview → Packages → pixi.toml → Version History
    # → Publications (publish) → Collaborators (share) → Jobs → Registries → ...
    (
        "01.wav",
        "Let's take a quick look at Nebee, "
        "a multi-user environment management platform built for pixie.",
    ),
    (
        "02.wav",
        "Once you log in, you land on the workspaces dashboard. "
        "This is where you can see all your environments at a glance, "
        "create new ones, or jump into an existing workspace.",
    ),
    (
        "03.wav",
        "Clicking into a workspace gives you a quick overview,"
        "like status, creation date, and collaborators."
        "with more details in each tab along the top.",
    ),
    (
        "04.wav",
        "You can view and edit the pixie dot toml configuration "
        "directly in the browser. "
        "Great for quick tweaks without opening a terminal.",
    ),
    (
        "05.wav",
        "The UI also makes adding a new package simple. "
        "Just open the UI Mode, type the package name, "
        "and hit install. Nebee handles the rest in the background.",
    ),
    (
        "06.wav",
        "Every change is automatically versioned. "
        "Each version stores the full pixie dot toml and lock file, "
        "so you can always roll back to any previous state.",
    ),
    (
        "07.wav",
        "All the heavy lifting happens through background jobs. "
        "You get full real-time logs for every operation, "
        "so you always know exactly what's going on.",
    ),
    (
        "08.wav",
        "If you'd like to share or collaborate with your team, "
        "just click share, pick a team member, "
        "set their permission level, and they're in.",
    ),
    (
        "09.wav",
        "To share your workspace with a larger group or publicly,"
        "you can publish your environment to an O.C.I. registry "
        "so your team can pull it from anywhere.",
    ),
    (
        "10.wav",
        "The registries page gives you a clear view "
        "of all connected O.C.I. registries "
        "and everything that's been published to them.",
    ),
    (
        "11.wav",
        "You can also browse existing registries, "
        "explore what's available, and import any environment with just a few clicks.",
    ),
    (
        "12.wav",
        "Over in the admin panel, you get a bird's-eye view of the entire platform.",
    ),
    (
        "13.wav",
        "User management is built right in. "
        "You can create accounts, assign roles, "
        "and control exactly who has access to what.",
    ),
    (
        "14.wav",
        "Managing registries is straightforward too. "
        "Add multiple O.C.I. registries and configure credentials, all from one place.",
    ),
    (
        "15.wav",
        "And finally, everything is tracked in the audit log. "
        "Every action, every change, fully accounted for.",
    ),
    (
        "16.wav",
        "That's Nebee. Give it a try, and let us know what you think!",
    ),
]


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    pipeline = KPipeline(
        repo_id="hexgrad/Kokoro-82M", lang_code="a"
    )  # American English

    durations = {}
    total_dur = 0.0
    for filename, text in NARRATIONS:
        out_path = OUTPUT_DIR / filename
        print(f"  Generating {filename}: {text!r}")

        chunks = []
        for _gs, _ps, audio in pipeline(text, voice=VOICE, speed=1.0):
            chunks.append(audio)

        if chunks:
            full_audio = np.concatenate(chunks)
            sf.write(str(out_path), full_audio, 24000)

        dur = out_path.stat().st_size / (24000 * 2)  # 16-bit mono
        dur_ms = round(dur * 1000)
        durations[filename] = dur_ms
        total_dur += dur
        print(f"    → {out_path.name} ({dur:.1f}s)")

    # Write durations JSON for record.ts timing guards
    dur_path = OUTPUT_DIR / "durations.json"
    with open(dur_path, "w") as f:
        json.dump(durations, f, indent=2)
    print(f"\nDurations saved: {dur_path}")

    print(f"Total narration: {total_dur:.1f}s")
    print("Audio generation complete.")


if __name__ == "__main__":
    main()
