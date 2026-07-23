#!/usr/bin/env python3
"""Download MSSP YouTube playlist episodes as date-prefixed M4As via yt-dlp."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

PLAYLIST_URL = "https://www.youtube.com/playlist?list=PL-zWbO9RZaSNL0oLkXQPAEvxJ_JzrA00i"
SHOW_PREFIX = "Matt and Shane_s Secret Podcast"
EPISODE_NUMBER_RE = re.compile(r"Ep\.?\s*-?\s*(\d+)", re.IGNORECASE)
SCRIPT_DIR = Path(__file__).resolve().parent


@dataclass
class PlaylistEntry:
    video_id: str
    title: str
    episode_number: int | None


@dataclass
class CookieConfig:
    cookies_file: Path | None = None
    cookies_browser: str | None = None


def load_env(env_path: Path) -> dict[str, str]:
    if not env_path.exists():
        return {}

    values: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_cookies_file(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = SCRIPT_DIR / path
    return path.resolve()


def load_cookie_config(
    env_path: Path,
    cookies_file_arg: str | None,
    cookies_browser_arg: str | None,
) -> CookieConfig:
    env = load_env(env_path)

    cookies_file_raw = cookies_file_arg or env.get("YOUTUBE_COOKIES_FILE", "").strip()
    cookies_browser = cookies_browser_arg or env.get("YOUTUBE_COOKIES_BROWSER", "").strip()

    cookies_file: Path | None = None
    if cookies_file_raw:
        candidate = resolve_cookies_file(cookies_file_raw)
        if candidate.exists() and candidate.stat().st_size > 0:
            cookies_file = candidate

    return CookieConfig(
        cookies_file=cookies_file,
        cookies_browser=cookies_browser or None,
    )


def run_ytdlp(args: list[str], cookies: CookieConfig) -> subprocess.CompletedProcess[str]:
    cmd = [
        "yt-dlp",
        "--js-runtimes",
        "node",
        "--remote-components",
        "ejs:github",
    ]
    if cookies.cookies_file:
        cmd.extend(["--cookies", str(cookies.cookies_file)])
    elif cookies.cookies_browser:
        cmd.extend(["--cookies-from-browser", cookies.cookies_browser])
    cmd.extend(args)
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def fetch_playlist_entries(
    playlist_url: str,
    cookies: CookieConfig,
) -> list[PlaylistEntry]:
    result = run_ytdlp(
        [
            "--flat-playlist",
            "--print",
            "%(id)s|%(title)s",
            playlist_url,
        ],
        cookies,
    )
    if result.returncode != 0:
        print(result.stderr or result.stdout, file=sys.stderr)
        raise RuntimeError("Failed to read playlist")

    entries: list[PlaylistEntry] = []
    for line in result.stdout.splitlines():
        if "|" not in line:
            continue
        video_id, title = line.split("|", 1)
        match = EPISODE_NUMBER_RE.search(title)
        episode_number = int(match.group(1)) if match else None
        entries.append(PlaylistEntry(video_id.strip(), title.strip(), episode_number))
    return entries


def sanitize_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "-", name).strip(" .")


def normalize_for_match(text: str) -> str:
    cleaned = sanitize_filename(text).lower().replace("_", " ")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip(" .")


def entry_already_downloaded(output_dir: Path, entry: PlaylistEntry) -> Path | None:
    target_title = normalize_for_match(entry.title)
    if not target_title:
        return None

    for path in output_dir.glob("*.m4a"):
        if path.stat().st_size <= 0:
            continue

        normalized_name = normalize_for_match(path.name)
        if target_title not in normalized_name:
            continue

        if entry.episode_number is not None and not re.search(
            rf"ep\.?\s*-?\s*{entry.episode_number}\b",
            normalized_name,
            re.IGNORECASE,
        ):
            continue

        return path
    return None


def archive_has_video(archive_file: Path, video_id: str) -> bool:
    if not archive_file.exists():
        return False
    target = f"youtube {video_id}"
    return any(line.strip() == target for line in archive_file.read_text(encoding="utf-8").splitlines())


def remove_from_archive(archive_file: Path, video_id: str) -> None:
    if not archive_file.exists():
        return
    target = f"youtube {video_id}"
    lines = [
        line
        for line in archive_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and line.strip() != target
    ]
    archive_file.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def download_entry(
    entry: PlaylistEntry,
    output_dir: Path,
    archive_file: Path,
    dry_run: bool,
    cookies: CookieConfig,
    *,
    use_archive: bool = True,
    use_sponsorblock: bool = False,
) -> None:
    video_url = f"https://www.youtube.com/watch?v={entry.video_id}"
    output_template = str(
        output_dir / f"%(upload_date>%Y-%m-%d)s {SHOW_PREFIX} %(title)s.%(ext)s"
    )

    if dry_run:
        print(f"    would download -> ... {SHOW_PREFIX} {entry.title}.m4a")
        print(f"    {video_url}")
        return

    cmd = [
        "--ignore-errors",
        "--no-overwrites",
        "--windows-filenames",
    ]
    if use_archive:
        cmd.extend(["--download-archive", str(archive_file)])
    if use_sponsorblock:
        cmd.extend(["--sponsorblock-remove", "sponsor"])
    cmd.extend(
        [
            "-f",
            "140/bestaudio[ext=m4a]/bestaudio",
            "-x",
            "--audio-format",
            "m4a",
            "--audio-quality",
            "0",
            "--sleep-interval",
            "3",
            "--max-sleep-interval",
            "8",
            "-o",
            output_template,
            video_url,
        ]
    )

    result = run_ytdlp(cmd, cookies)
    combined = f"{result.stdout}\n{result.stderr}".strip()
    if result.returncode != 0:
        archive_skip = (
            "has already been recorded in the archive" in combined
            or "has already been downloaded" in combined
        )
        if archive_skip:
            return
        raise RuntimeError(combined)


def ensure_downloaded(
    entry: PlaylistEntry,
    output_dir: Path,
    archive_file: Path,
    cookies: CookieConfig,
    *,
    use_sponsorblock: bool = False,
) -> Path:
    existing = entry_already_downloaded(output_dir, entry)
    if existing:
        return existing

    if archive_has_video(archive_file, entry.video_id):
        print("    archive entry found but file missing; retrying without archive", flush=True)
        remove_from_archive(archive_file, entry.video_id)

    download_entry(
        entry,
        output_dir,
        archive_file,
        False,
        cookies,
        use_archive=True,
        use_sponsorblock=use_sponsorblock,
    )
    existing = entry_already_downloaded(output_dir, entry)
    if existing:
        return existing

    print("    archive entry found but file missing; retrying without archive", flush=True)
    remove_from_archive(archive_file, entry.video_id)
    download_entry(
        entry,
        output_dir,
        archive_file,
        False,
        cookies,
        use_archive=False,
        use_sponsorblock=use_sponsorblock,
    )
    existing = entry_already_downloaded(output_dir, entry)
    if not existing:
        raise RuntimeError("Download finished but M4A file was not created")
    return existing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=SCRIPT_DIR,
        help="Directory to save M4A files (default: script folder)",
    )
    parser.add_argument(
        "--min-episode",
        type=int,
        default=617,
        help="Start at this episode number, inclusive (default: 617; use 1 with --all)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Process the entire playlist, including episodes without numbers",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=SCRIPT_DIR / ".env",
        help="Path to .env file (default: script folder/.env)",
    )
    parser.add_argument(
        "--cookies-file",
        default="",
        help="Override YOUTUBE_COOKIES_FILE from .env",
    )
    parser.add_argument(
        "--cookies-from-browser",
        default="",
        help="Optional browser fallback (chrome, edge, firefox)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List episodes without downloading",
    )
    parser.add_argument(
        "--reset-archive",
        action="store_true",
        help="Clear download_archive.txt before starting (use after deleting M4As)",
    )
    parser.add_argument(
        "--sponsorblock",
        action="store_true",
        help="Remove sponsor segments (off by default)",
    )
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    if not shutil.which("yt-dlp"):
        print("yt-dlp is not installed or not on PATH.", file=sys.stderr)
        return 1
    if not shutil.which("ffmpeg"):
        print("ffmpeg is not installed or not on PATH.", file=sys.stderr)
        return 1

    args.output_dir.mkdir(parents=True, exist_ok=True)
    archive_file = args.output_dir / "download_archive.txt"
    if args.reset_archive and archive_file.exists():
        archive_file.unlink()
        print(f"Cleared archive: {archive_file}")
    cookies = load_cookie_config(
        args.env_file,
        args.cookies_file.strip() or None,
        args.cookies_from_browser.strip() or None,
    )

    if cookies.cookies_file:
        print(f"Using cookies file: {cookies.cookies_file}")
    elif cookies.cookies_browser:
        print(f"Using cookies from browser: {cookies.cookies_browser}")
    else:
        print(
            "No cookies configured. Age-restricted episodes may fail. "
            "Add cookies to cookies.txt and set YOUTUBE_COOKIES_FILE in .env."
        )

    print(f"Fetching playlist: {PLAYLIST_URL}")
    entries = fetch_playlist_entries(PLAYLIST_URL, cookies)
    if args.all:
        selected = [
            entry
            for entry in entries
            if entry.episode_number is None or entry.episode_number >= args.min_episode
        ]
        print(f"Found {len(selected)} playlist entries to check.")
    else:
        selected = [
            entry
            for entry in entries
            if entry.episode_number is not None and entry.episode_number >= args.min_episode
        ]
        selected.sort(key=lambda entry: entry.episode_number or 0)
        print(f"Found {len(selected)} episodes from Ep. {args.min_episode} onward.")

    downloaded = 0
    skipped = 0
    failed: list[tuple[str, str]] = []

    for index, entry in enumerate(selected, start=1):
        if entry.episode_number is not None:
            label = f"Ep. {entry.episode_number} - {entry.title}"
        else:
            label = entry.title
        print(f"[{index}/{len(selected)}] {label}", flush=True)
        try:
            existing = entry_already_downloaded(args.output_dir, entry)
            if existing:
                print(f"    skip (already exists): {existing.name}", flush=True)
                skipped += 1
                continue

            if args.dry_run:
                download_entry(
                    entry,
                    args.output_dir,
                    archive_file,
                    True,
                    cookies,
                    use_sponsorblock=args.sponsorblock,
                )
                downloaded += 1
                continue

            saved = ensure_downloaded(
                entry,
                args.output_dir,
                archive_file,
                cookies,
                use_sponsorblock=args.sponsorblock,
            )
            print(f"    done -> {saved.name}", flush=True)
            downloaded += 1
        except Exception as exc:  # noqa: BLE001 - collect and continue
            print(f"    FAILED: {exc}", flush=True)
            failed.append((label, str(exc)))

    print()
    print(f"Complete. Processed: {downloaded}, skipped: {skipped}, failed: {len(failed)}")
    if failed:
        print("Failures:")
        for label, message in failed:
            print(f"  {label}: {message}")
        print()
    if not args.dry_run:
        print(
            "Rename step is separate. After all downloads finish, run:\n"
            f"  python {SCRIPT_DIR / 'rename_episodes.py'}"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
